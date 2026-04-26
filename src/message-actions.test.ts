import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _closeDatabase,
  _initTestDatabase,
  getCommunicationThread,
  getMessageAction,
  getOutcomeBySource,
  getTaskById,
  storeChatMetadata,
  storeMessageDirect,
  upsertCommunicationThread,
  upsertDelegationRule,
} from './db.js';
import {
  applyMessageActionOperation,
  buildBlueBubblesProofDrillPresentationText,
  canUseBareBlueBubblesMessageActionFollowup,
  createOrRefreshMessageActionFromDraft,
  ensureBlueBubblesSelfThreadMessageActionForReplyText,
  findLatestChatMessageAction,
  isBlueBubblesProofDrillAction,
  isBlueBubblesExplicitSendAlias,
  interpretMessageActionFollowup,
  listBlueBubblesMessageActionContinuitySnapshots,
  parseExplicitBlueBubblesThreadSendIntent,
  reconcileBlueBubblesMessageActionContinuity,
  reconcileBlueBubblesSelfThreadContinuity,
  resolveBlueBubblesProofDrillSnapshot,
  resolveBlueBubblesThreadTargetByName,
  resolveMessageActionForFollowup,
  runScheduledMessageActionByTaskId,
  startBlueBubblesProofDrill,
} from './message-actions.js';
import type {
  CommunicationThreadRecord,
  DelegationRuleRecord,
} from './types.js';

const originalFetch = globalThis.fetch;

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
      overrides.channelApplicabilityJson ||
      JSON.stringify(['telegram', 'bluebubbles']),
    safetyLevel: overrides.safetyLevel || 'safe_to_auto_after_delegation',
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
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
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
    expect(
      findLatestChatMessageAction({ groupFolder: 'main', chatJid: 'bb:chat-1' })
        ?.messageActionId,
    ).toBe(action.messageActionId);
    expect(
      getOutcomeBySource('main', 'message_action', action.messageActionId)
        ?.status,
    ).toBe('partial');
  });

  it('finds the latest self-thread message action across BlueBubbles self-thread aliases', () => {
    const action = createOrRefreshMessageActionFromDraft({
      groupFolder: 'main',
      presentationChannel: 'bluebubbles',
      presentationChatJid: 'bb:iMessage;-;+14695405551',
      sourceType: 'manual_prompt',
      sourceKey: 'self-thread-followup-proof',
      sourceSummary: 'Draft text message to Candace.',
      draftText: 'Hey Candace, does dinner still work tonight?',
      personName: 'Candace',
      threadTitle: 'Candace',
      communicationContext: 'general',
      targetOverride: {
        kind: 'external_thread',
        chatJid: 'bb:iMessage;+;chat-candace',
        threadId: null,
        replyToMessageId: null,
        isGroup: false,
        personName: 'Candace',
      },
      targetChannelOverride: 'bluebubbles',
      now: new Date('2026-04-16T16:06:22.703Z'),
    });

    expect(
      findLatestChatMessageAction({
        groupFolder: 'main',
        chatJid: 'bb:iMessage;-;jeffstory007@gmail.com',
        now: new Date('2026-04-16T16:20:00.000Z'),
      })?.messageActionId,
    ).toBe(action.messageActionId);
    expect(
      resolveMessageActionForFollowup({
        groupFolder: 'main',
        chatJid: 'bb:iMessage;-;jeffstory007@gmail.com',
        rawText: 'send it later tonight',
        now: new Date('2026-04-16T16:20:00.000Z'),
      })?.messageActionId,
    ).toBe(action.messageActionId);
  });

  it('rehydrates a fresh BlueBubbles self-thread draft presentation into a message action', () => {
    storeChatMetadata(
      'bb:iMessage;+;chat-candace',
      '2026-04-16T16:05:00.000Z',
      'Candace',
      'bluebubbles',
      false,
    );
    storeChatMetadata(
      'bb:iMessage;-;jeffstory007@gmail.com',
      '2026-04-16T16:06:22.703Z',
      'Jeff',
      'bluebubbles',
      false,
    );
    storeMessageDirect({
      id: 'bb:self-thread-draft-1',
      chat_jid: 'bb:iMessage;-;jeffstory007@gmail.com',
      sender: 'Andrea',
      sender_name: 'Andrea',
      content: [
        'Andrea: I drafted a reply.',
        '',
        'Target: Candace in Messages.',
        '',
        'Draft:',
        'Hey Candace, tonight still works for me.',
        '',
        'Status: drafted and ready to send.',
      ].join('\n'),
      timestamp: '2026-04-16T16:06:22.703Z',
      is_from_me: true,
      is_bot_message: true,
    });

    const action = resolveMessageActionForFollowup({
      groupFolder: 'main',
      chatJid: 'bb:iMessage;-;+14695405551',
      rawText: 'send it later tonight',
      now: new Date('2026-04-16T16:20:00.000Z'),
    });

    expect(action?.messageActionId).toBeTruthy();
    expect(action?.presentationChatJid).toBe('bb:iMessage;-;+14695405551');
    expect(action?.presentationMessageId).toBe('bb:self-thread-draft-1');
    expect(action?.draftText).toBe('Hey Candace, tonight still works for me.');
    expect(JSON.parse(action?.targetConversationJson || '{}')).toMatchObject({
      chatJid: 'bb:iMessage;+;chat-candace',
      personName: 'Candace',
    });
  });

  it('ensures draft-like BlueBubbles self-thread replies have an active action record', () => {
    storeChatMetadata(
      'bb:iMessage;+;chat-candace',
      '2026-04-16T16:05:00.000Z',
      'Candace',
      'bluebubbles',
      false,
    );
    storeChatMetadata(
      'bb:iMessage;-;jeffstory007@gmail.com',
      '2026-04-16T16:06:22.703Z',
      'Jeff',
      'bluebubbles',
      false,
    );

    const action = ensureBlueBubblesSelfThreadMessageActionForReplyText({
      groupFolder: 'main',
      chatJid: 'bb:iMessage;-;jeffstory007@gmail.com',
      presentationMessageId: 'bb:self-thread-draft-ensure',
      replyText: [
        'Andrea: I drafted a reply.',
        '',
        'Target: Candace in Messages.',
        '',
        'Draft:',
        'Hey Candace, tonight still works for me.',
        '',
        'Status: drafted and ready to send.',
      ].join('\n'),
      now: new Date('2026-04-16T16:07:00.000Z'),
    });

    expect(action?.messageActionId).toBeTruthy();
    expect(action?.presentationChatJid).toBe('bb:iMessage;-;+14695405551');
    expect(action?.presentationMessageId).toBe('bb:self-thread-draft-ensure');
    expect(action?.draftText).toBe('Hey Candace, tonight still works for me.');
  });

  it('collapses duplicate same-thread BlueBubbles drafts to one active action', () => {
    const older = createOrRefreshMessageActionFromDraft({
      groupFolder: 'main',
      presentationChannel: 'bluebubbles',
      presentationChatJid: 'bb:iMessage;-;+14695405551',
      sourceType: 'manual_prompt',
      sourceKey: 'duplicate-self-thread-older',
      sourceSummary: 'Draft text message to Candace.',
      draftText: 'Hey Candace, tonight still works for me.',
      personName: 'Candace',
      threadTitle: 'Candace',
      communicationContext: 'general',
      targetOverride: {
        kind: 'external_thread',
        chatJid: 'bb:iMessage;+;chat-candace',
        threadId: null,
        replyToMessageId: null,
        isGroup: false,
        personName: 'Candace',
      },
      targetChannelOverride: 'bluebubbles',
      now: new Date('2026-04-16T16:00:00.000Z'),
    });
    const newer = createOrRefreshMessageActionFromDraft({
      groupFolder: 'main',
      presentationChannel: 'bluebubbles',
      presentationChatJid: 'bb:iMessage;-;+14695405551',
      sourceType: 'manual_prompt',
      sourceKey: 'duplicate-self-thread-newer',
      sourceSummary: 'Draft text message to Candace.',
      draftText: 'Hey Candace, tonight still works for me.',
      personName: 'Candace',
      threadTitle: 'Candace',
      communicationContext: 'general',
      targetOverride: {
        kind: 'external_thread',
        chatJid: 'bb:iMessage;+;chat-candace',
        threadId: null,
        replyToMessageId: null,
        isGroup: false,
        personName: 'Candace',
      },
      targetChannelOverride: 'bluebubbles',
      now: new Date('2026-04-16T16:05:00.000Z'),
    });

    const continuity = reconcileBlueBubblesSelfThreadContinuity({
      groupFolder: 'main',
      chatJid: 'bb:iMessage;-;jeffstory007@gmail.com',
      now: new Date('2026-04-16T16:10:00.000Z'),
      allowRehydrate: false,
    });

    expect(continuity.activeMessageActionId).toBe(newer.messageActionId);
    expect(continuity.openMessageActionCount).toBe(1);
    expect(continuity.supersededActionIds).toContain(older.messageActionId);
    expect(getMessageAction(older.messageActionId)?.sendStatus).toBe('skipped');
    expect(getMessageAction(newer.messageActionId)?.sendStatus).toBe('drafted');
  });

  it('skips stale self-thread BlueBubbles actions when no fresh draft remains', () => {
    const stale = createOrRefreshMessageActionFromDraft({
      groupFolder: 'main',
      presentationChannel: 'bluebubbles',
      presentationChatJid: 'bb:iMessage;-;+14695405551',
      sourceType: 'manual_prompt',
      sourceKey: 'stale-self-thread-only',
      sourceSummary: 'Older draft text message to Candace.',
      draftText: 'Older Candace draft.',
      personName: 'Candace',
      threadTitle: 'Candace',
      communicationContext: 'general',
      targetOverride: {
        kind: 'external_thread',
        chatJid: 'bb:iMessage;+;chat-candace',
        threadId: null,
        replyToMessageId: null,
        isGroup: false,
        personName: 'Candace',
      },
      targetChannelOverride: 'bluebubbles',
      now: new Date('2026-04-16T15:00:00.000Z'),
    });

    const continuity = reconcileBlueBubblesSelfThreadContinuity({
      groupFolder: 'main',
      chatJid: 'bb:iMessage;-;jeffstory007@gmail.com',
      now: new Date('2026-04-16T16:20:00.000Z'),
      allowRehydrate: true,
    });

    expect(continuity.activeMessageActionId).toBeNull();
    expect(continuity.openMessageActionCount).toBe(0);
    expect(continuity.continuityState).toBe('idle');
    expect(continuity.supersededActionIds).toContain(stale.messageActionId);
    expect(getMessageAction(stale.messageActionId)?.sendStatus).toBe('skipped');
    expect(
      findLatestChatMessageAction({
        groupFolder: 'main',
        chatJid: 'bb:iMessage;-;jeffstory007@gmail.com',
      }),
    ).toBeUndefined();
  });

  it('starts one active BlueBubbles proof drill action and refreshes it on repeat start', () => {
    const first = startBlueBubblesProofDrill({
      groupFolder: 'main',
      chatJid: 'bb:iMessage;-;jeffstory007@gmail.com',
      now: new Date('2026-04-16T16:00:00.000Z'),
    });
    const second = startBlueBubblesProofDrill({
      groupFolder: 'main',
      chatJid: 'bb:iMessage;-;+14695405551',
      now: new Date('2026-04-16T16:05:00.000Z'),
    });
    const snapshot = resolveBlueBubblesProofDrillSnapshot({
      groupFolder: 'main',
      now: new Date('2026-04-16T16:05:00.000Z'),
    });
    const continuity = reconcileBlueBubblesSelfThreadContinuity({
      groupFolder: 'main',
      chatJid: 'bb:iMessage;-;+14695405551',
      now: new Date('2026-04-16T16:05:00.000Z'),
      allowRehydrate: false,
    });

    expect(second.action.messageActionId).toBe(first.action.messageActionId);
    expect(isBlueBubblesProofDrillAction(second.action)).toBe(true);
    expect(snapshot.proofDrillState).toBe('active');
    expect(snapshot.proofDrillActionId).toBe(second.action.messageActionId);
    expect(continuity.openMessageActionCount).toBe(1);
    expect(continuity.activeMessageActionId).toBe(
      second.action.messageActionId,
    );
    expect(buildBlueBubblesProofDrillPresentationText(second.action)).toContain(
      'send it later tonight',
    );
  });

  it('keeps BlueBubbles proof drills deferred-only and rejects immediate send', async () => {
    const started = startBlueBubblesProofDrill({
      groupFolder: 'main',
      now: new Date('2026-04-16T16:00:00.000Z'),
    });
    const sendToTarget = vi.fn(async () => ({ platformMessageId: 'unused' }));

    const blocked = await applyMessageActionOperation(
      started.action.messageActionId,
      { kind: 'send' },
      {
        groupFolder: 'main',
        channel: 'bluebubbles',
        chatJid: started.action.presentationChatJid || '',
        currentTime: new Date('2026-04-16T16:01:00.000Z'),
        sendToTarget,
      },
    );
    expect(blocked.replyText).toContain('will not send');
    expect(getMessageAction(started.action.messageActionId)?.sendStatus).toBe(
      'drafted',
    );

    const deferred = await applyMessageActionOperation(
      started.action.messageActionId,
      { kind: 'defer', timingHint: 'later tonight' },
      {
        groupFolder: 'main',
        channel: 'bluebubbles',
        chatJid: started.action.presentationChatJid || '',
        currentTime: new Date('2026-04-16T16:02:00.000Z'),
        sendToTarget,
      },
    );
    expect(deferred.action?.sendStatus).toBe('deferred');
    expect(deferred.action?.lastActionKind).toBe('remind_instead');
    expect(sendToTarget).not.toHaveBeenCalled();
    expect(
      resolveBlueBubblesProofDrillSnapshot({
        groupFolder: 'main',
        now: new Date('2026-04-16T16:02:00.000Z'),
      }).proofDrillState,
    ).toBe('deferred');
  });

  it('prefers a fresh rehydrated self-thread draft over a stale older action', () => {
    const stale = createOrRefreshMessageActionFromDraft({
      groupFolder: 'main',
      presentationChannel: 'bluebubbles',
      presentationChatJid: 'bb:iMessage;-;+14695405551',
      sourceType: 'manual_prompt',
      sourceKey: 'stale-self-thread-action',
      sourceSummary: 'Older draft text message to Candace.',
      draftText: 'Older Candace draft.',
      personName: 'Candace',
      threadTitle: 'Candace',
      communicationContext: 'general',
      targetOverride: {
        kind: 'external_thread',
        chatJid: 'bb:iMessage;+;chat-candace',
        threadId: null,
        replyToMessageId: null,
        isGroup: false,
        personName: 'Candace',
      },
      targetChannelOverride: 'bluebubbles',
      now: new Date('2026-04-16T15:00:00.000Z'),
    });
    storeChatMetadata(
      'bb:iMessage;+;chat-candace',
      '2026-04-16T16:05:00.000Z',
      'Candace',
      'bluebubbles',
      false,
    );
    storeChatMetadata(
      'bb:iMessage;-;jeffstory007@gmail.com',
      '2026-04-16T16:06:22.703Z',
      'Jeff',
      'bluebubbles',
      false,
    );
    storeMessageDirect({
      id: 'bb:self-thread-draft-fresh',
      chat_jid: 'bb:iMessage;-;jeffstory007@gmail.com',
      sender: 'Andrea',
      sender_name: 'Andrea',
      content: [
        'Andrea: I drafted a reply.',
        '',
        'Target: Candace in Messages.',
        '',
        'Draft:',
        'Hey Candace, tonight still works for me.',
        '',
        'Status: drafted and ready to send.',
      ].join('\n'),
      timestamp: '2026-04-16T16:06:22.703Z',
      is_from_me: true,
      is_bot_message: true,
    });

    const resolved = resolveMessageActionForFollowup({
      groupFolder: 'main',
      chatJid: 'bb:iMessage;-;+14695405551',
      rawText: 'send it later tonight',
      now: new Date('2026-04-16T16:20:00.000Z'),
    });

    expect(resolved?.draftText).toBe(
      'Hey Candace, tonight still works for me.',
    );
    expect(resolved?.presentationMessageId).toBe('bb:self-thread-draft-fresh');
    expect(resolved?.sourceKey).toContain('rehydrated-bluebubbles-draft');
    expect(getMessageAction(stale.messageActionId)?.sendStatus).toBe('skipped');
  });

  it('marks group continuity as explicit-only and limits followups to inspection and rewrites', () => {
    storeChatMetadata(
      'bb:iMessage;+;family-group',
      '2026-04-16T18:00:00.000Z',
      'Family Group',
      'bluebubbles',
      true,
    );
    const groupAction = createOrRefreshMessageActionFromDraft({
      groupFolder: 'main',
      presentationChannel: 'bluebubbles',
      presentationChatJid: 'bb:iMessage;+;family-group',
      sourceType: 'manual_prompt',
      sourceKey: 'group-draft',
      sourceSummary: 'Draft text message to Family Group.',
      draftText: 'We can do dinner around 7.',
      personName: 'Family Group',
      threadTitle: 'Family Group',
      communicationContext: 'general',
      targetOverride: {
        kind: 'external_thread',
        chatJid: 'bb:iMessage;+;family-group',
        threadId: null,
        replyToMessageId: null,
        isGroup: true,
        personName: 'Family Group',
      },
      targetChannelOverride: 'bluebubbles',
      now: new Date('2026-04-16T18:05:00.000Z'),
    });

    const continuity = reconcileBlueBubblesMessageActionContinuity({
      groupFolder: 'main',
      chatJid: 'bb:iMessage;+;family-group',
      now: new Date('2026-04-16T18:10:00.000Z'),
      allowRehydrate: true,
    });

    expect(continuity.activeMessageActionId).toBe(groupAction.messageActionId);
    expect(continuity.conversationKind).toBe('group');
    expect(continuity.decisionPolicy).toBe('explicit_only');
    expect(continuity.requiresExplicitMention).toBe(true);
    expect(continuity.eligibleFollowups).toEqual([
      'show it again',
      'make it shorter',
      'make it more direct',
    ]);
  });

  it('treats a recent direct 1:1 BlueBubbles chat as conversational after fresh Andrea context', () => {
    storeChatMetadata(
      'bb:iMessage;-;+12147254219',
      '2026-04-16T18:05:00.000Z',
      'Candace',
      'bluebubbles',
      false,
    );
    storeMessageDirect({
      id: 'bb:direct-recent-andrea',
      chat_jid: 'bb:iMessage;-;+12147254219',
      sender: 'Andrea',
      sender_name: 'Andrea',
      content: 'Andrea: Here is the latest draft option.',
      timestamp: '2026-04-16T18:08:00.000Z',
      is_from_me: true,
      is_bot_message: true,
    });

    const continuity = reconcileBlueBubblesMessageActionContinuity({
      groupFolder: 'main',
      chatJid: 'bb:iMessage;-;+12147254219',
      now: new Date('2026-04-16T18:10:00.000Z'),
      allowRehydrate: true,
    });

    expect(continuity.conversationKind).toBe('direct_1to1');
    expect(continuity.decisionPolicy).toBe('semi_auto_recent_direct_1to1');
    expect(continuity.conversationalEligibility).toBe('conversational_now');
    expect(continuity.requiresExplicitMention).toBe(false);
    expect(continuity.recentTargetChatJid).toBe('bb:iMessage;-;+12147254219');
    expect(
      listBlueBubblesMessageActionContinuitySnapshots({
        groupFolder: 'main',
        now: new Date('2026-04-16T18:10:00.000Z'),
        allowRehydrate: true,
      }).some(
        (snapshot) =>
          snapshot.recentTargetChatJid === 'bb:iMessage;-;+12147254219' &&
          snapshot.decisionPolicy === 'semi_auto_recent_direct_1to1',
      ),
    ).toBe(true);
  });

  it('keeps stale direct 1:1 BlueBubbles continuity explicit-only when Andrea context is no longer fresh', () => {
    storeChatMetadata(
      'bb:iMessage;-;+12147254219',
      '2026-04-16T16:05:00.000Z',
      'Candace',
      'bluebubbles',
      false,
    );
    storeMessageDirect({
      id: 'bb:direct-stale-andrea',
      chat_jid: 'bb:iMessage;-;+12147254219',
      sender: 'Andrea',
      sender_name: 'Andrea',
      content: 'Andrea: Here is the latest draft option.',
      timestamp: '2026-04-16T16:00:00.000Z',
      is_from_me: true,
      is_bot_message: true,
    });

    const continuity = reconcileBlueBubblesMessageActionContinuity({
      groupFolder: 'main',
      chatJid: 'bb:iMessage;-;+12147254219',
      now: new Date('2026-04-16T18:10:00.000Z'),
      allowRehydrate: true,
    });

    expect(continuity.conversationKind).toBe('direct_1to1');
    expect(continuity.decisionPolicy).toBe('explicit_only');
    expect(continuity.conversationalEligibility).toBe('explicit_only');
    expect(continuity.requiresExplicitMention).toBe(true);
  });

  it('sorts continuity snapshots with the active self-thread ahead of group continuity', () => {
    storeChatMetadata(
      'bb:iMessage;+;family-group',
      '2026-04-16T18:00:00.000Z',
      'Family Group',
      'bluebubbles',
      true,
    );
    createOrRefreshMessageActionFromDraft({
      groupFolder: 'main',
      presentationChannel: 'bluebubbles',
      presentationChatJid: 'bb:iMessage;+;family-group',
      sourceType: 'manual_prompt',
      sourceKey: 'group-draft-2',
      sourceSummary: 'Draft text message to Family Group.',
      draftText: 'We can do dinner around 7.',
      personName: 'Family Group',
      threadTitle: 'Family Group',
      communicationContext: 'general',
      targetOverride: {
        kind: 'external_thread',
        chatJid: 'bb:iMessage;+;family-group',
        threadId: null,
        replyToMessageId: null,
        isGroup: true,
        personName: 'Family Group',
      },
      targetChannelOverride: 'bluebubbles',
      now: new Date('2026-04-16T18:05:00.000Z'),
    });
    createOrRefreshMessageActionFromDraft({
      groupFolder: 'main',
      presentationChannel: 'bluebubbles',
      presentationChatJid: 'bb:iMessage;-;+14695405551',
      sourceType: 'manual_prompt',
      sourceKey: 'self-thread-draft-order',
      sourceSummary: 'Draft text message to Candace.',
      draftText: 'Tonight still works for me.',
      personName: 'Candace',
      threadTitle: 'Candace',
      communicationContext: 'general',
      targetOverride: {
        kind: 'external_thread',
        chatJid: 'bb:iMessage;+;chat-candace',
        threadId: null,
        replyToMessageId: null,
        isGroup: false,
        personName: 'Candace',
      },
      targetChannelOverride: 'bluebubbles',
      now: new Date('2026-04-16T18:06:00.000Z'),
    });

    const snapshots = listBlueBubblesMessageActionContinuitySnapshots({
      groupFolder: 'main',
      now: new Date('2026-04-16T18:10:00.000Z'),
      allowRehydrate: true,
    });

    expect(snapshots[0]?.conversationKind).toBe('self_thread');
    expect(
      snapshots.some((snapshot) => snapshot.conversationKind === 'group'),
    ).toBe(true);
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
    const sendToTarget = vi.fn(async () => ({
      platformMessageId: 'bb:sent-1',
    }));

    const result = await applyMessageActionOperation(
      action.messageActionId,
      { kind: 'send' },
      {
        groupFolder: 'main',
        channel: 'bluebubbles',
        chatJid: 'bb:chat-1',
        currentTime: new Date('2026-04-08T19:12:00.000Z'),
        sendToTarget,
      },
    );

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
      getOutcomeBySource('main', 'message_action', action.messageActionId)
        ?.status,
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
    const reminderId = JSON.parse(
      updated.linkedRefsJson || '{}',
    ).reminderTaskId;

    expect(result.handled).toBe(true);
    expect(result.replyText).toContain('kept the draft unsent');
    expect(updated.sendStatus).toBe('deferred');
    expect(updated.lastActionKind).toBe('remind_instead');
    expect(reminderId).toBeTruthy();
    expect(getTaskById(reminderId)?.prompt).toContain(
      'Revisit this draft reply',
    );
    expect(
      getOutcomeBySource('main', 'message_action', action.messageActionId)
        ?.status,
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
    const outcome = getOutcomeBySource(
      'main',
      'message_action',
      action.messageActionId,
    )!;

    expect(result.handled).toBe(true);
    expect(updated.sendStatus).toBe('deferred');
    expect(updated.lastActionKind).toBe('save_to_thread');
    expect(updated.requiresApproval).toBe(false);
    expect(linkedRefs.threadId).toBeTruthy();
    expect(getCommunicationThread(thread.id)?.suggestedNextAction).toBe(
      'save_for_later',
    );
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
    const sendToTarget = vi.fn(async () => ({
      platformMessageId: 'bb:sent-2',
    }));

    await applyMessageActionOperation(
      action.messageActionId,
      { kind: 'send' },
      {
        groupFolder: 'main',
        channel: 'bluebubbles',
        chatJid: 'bb:chat-1',
        currentTime: new Date('2026-04-08T19:21:00.000Z'),
        sendToTarget,
      },
    );
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

    const result = await applyMessageActionOperation(
      action.messageActionId,
      { kind: 'defer' },
      {
        groupFolder: 'main',
        channel: 'bluebubbles',
        chatJid: 'bb:chat-1',
        currentTime: new Date('2026-04-08T19:26:00.000Z'),
        sendToTarget: vi.fn(async () => ({ platformMessageId: 'unused' })),
      },
    );

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

    await applyMessageActionOperation(
      action.messageActionId,
      { kind: 'defer' },
      {
        groupFolder: 'main',
        channel: 'bluebubbles',
        chatJid: 'bb:chat-1',
        currentTime: new Date('2026-04-08T19:31:00.000Z'),
        sendToTarget: vi.fn(async () => ({ platformMessageId: 'unused' })),
      },
    );
    const scheduled = getMessageAction(action.messageActionId)!;

    await applyMessageActionOperation(
      scheduled.messageActionId,
      { kind: 'cancel_deferred' },
      {
        groupFolder: 'main',
        channel: 'bluebubbles',
        chatJid: 'bb:chat-1',
        currentTime: new Date('2026-04-08T19:32:00.000Z'),
        sendToTarget: vi.fn(async () => ({ platformMessageId: 'unused' })),
      },
    );

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

    await applyMessageActionOperation(
      action.messageActionId,
      { kind: 'defer' },
      {
        groupFolder: 'main',
        channel: 'bluebubbles',
        chatJid: 'bb:chat-1',
        currentTime: new Date('2026-04-08T19:36:00.000Z'),
        sendToTarget: vi.fn(async () => ({ platformMessageId: 'unused' })),
      },
    );
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

    await applyMessageActionOperation(
      action.messageActionId,
      { kind: 'defer' },
      {
        groupFolder: 'main',
        channel: 'bluebubbles',
        chatJid: 'bb:chat-1',
        currentTime: new Date('2026-04-08T19:39:00.000Z'),
        sendToTarget: vi.fn(async () => ({ platformMessageId: 'unused' })),
      },
    );
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

  it('uses the Messages model lane for BlueBubbles rewrites when available', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    vi.stubEnv('OPENAI_BASE_URL', 'https://openai.test/v1');
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            output_text:
              '{"draftText":"Hey Candace, tonight still works for me. If you want, we can keep it easy."}',
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
    ) as typeof fetch;

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

    const result = await applyMessageActionOperation(
      action.messageActionId,
      { kind: 'rewrite', style: 'warmer' },
      {
        groupFolder: 'main',
        channel: 'bluebubbles',
        chatJid: 'bb:chat-1',
        currentTime: new Date('2026-04-08T19:39:00.000Z'),
        sendToTarget: vi.fn(async () => ({ platformMessageId: 'unused' })),
      },
    );

    expect(result.handled).toBe(true);
    expect(result.replyText).toContain('made it warmer');
    expect(getMessageAction(action.messageActionId)?.draftText).toContain(
      'keep it easy',
    );
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

    await applyMessageActionOperation(
      action.messageActionId,
      { kind: 'defer' },
      {
        groupFolder: 'main',
        channel: 'bluebubbles',
        chatJid: 'bb:chat-1',
        currentTime: new Date('2026-04-08T19:41:00.000Z'),
        sendToTarget: vi.fn(async () => ({ platformMessageId: 'unused' })),
      },
    );
    const scheduled = getMessageAction(action.messageActionId)!;
    const sendToTarget = vi.fn(async () => ({
      platformMessageId: 'bb:sent-scheduled',
    }));

    const runResult = await runScheduledMessageActionByTaskId(
      scheduled.scheduledTaskId!,
      {
        groupFolder: 'main',
        channel: 'bluebubbles',
        chatJid: 'bb:chat-1',
        currentTime: new Date('2026-04-08T21:00:00.000Z'),
        sendToTarget,
      },
    );

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
    expect(getCommunicationThread(thread.id)?.followupState).toBe(
      'waiting_on_them',
    );
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

  it('does not bind a bare followup to a stale open message action', () => {
    createOrRefreshMessageActionFromDraft({
      groupFolder: 'main',
      presentationChannel: 'telegram',
      presentationChatJid: 'tg:main',
      sourceType: 'communication_thread',
      sourceKey: 'comm-stale',
      sourceSummary: 'Older Candace draft.',
      draftText: 'Yes, tonight still works for me.',
      personName: 'Candace',
      threadTitle: 'Candace',
      communicationThreadId: 'comm-stale',
      communicationContext: 'reply_followthrough',
      now: new Date('2026-04-08T19:00:00.000Z'),
    });

    const resolved = resolveMessageActionForFollowup({
      groupFolder: 'main',
      chatJid: 'tg:main',
      rawText: 'make that less stiff',
      now: new Date('2026-04-08T20:00:01.000Z'),
    });

    expect(resolved).toBeUndefined();
  });

  it('treats BlueBubbles send-using phrasing as a send follow-up', () => {
    expect(interpretMessageActionFollowup('send using blue bubbles')).toEqual({
      kind: 'send',
    });
    expect(isBlueBubblesExplicitSendAlias('send that using blue bubbles')).toBe(
      true,
    );
  });

  it('treats natural rewrite aliases as message-action followups', () => {
    expect(interpretMessageActionFollowup('make that less stiff')).toEqual({
      kind: 'rewrite',
      style: 'warmer',
    });
    expect(interpretMessageActionFollowup('more blunt')).toEqual({
      kind: 'rewrite',
      style: 'more_direct',
    });
    expect(interpretMessageActionFollowup('save that')).toEqual({
      kind: 'save_to_thread',
    });
  });

  it('allows bare self-thread defers but keeps immediate send and group decisions stricter', () => {
    createOrRefreshMessageActionFromDraft({
      groupFolder: 'main',
      presentationChannel: 'bluebubbles',
      presentationChatJid: 'bb:iMessage;-;+14695405551',
      sourceType: 'manual_prompt',
      sourceKey: 'self-thread-policy',
      sourceSummary: 'Draft text message to Candace.',
      draftText: 'Tonight still works for me.',
      personName: 'Candace',
      threadTitle: 'Candace',
      communicationContext: 'general',
      targetOverride: {
        kind: 'external_thread',
        chatJid: 'bb:iMessage;+;chat-candace',
        threadId: null,
        replyToMessageId: null,
        isGroup: false,
        personName: 'Candace',
      },
      targetChannelOverride: 'bluebubbles',
      now: new Date('2026-04-16T19:00:00.000Z'),
    });
    const selfThreadContinuity = reconcileBlueBubblesMessageActionContinuity({
      groupFolder: 'main',
      chatJid: 'bb:iMessage;-;+14695405551',
      now: new Date('2026-04-16T19:05:00.000Z'),
      allowRehydrate: true,
    });
    const groupContinuity = {
      ...selfThreadContinuity,
      conversationKind: 'group' as const,
      decisionPolicy: 'explicit_only' as const,
      requiresExplicitMention: true,
      eligibleFollowups: [
        'show it again',
        'make it shorter',
        'make it more direct',
      ],
    };

    expect(
      canUseBareBlueBubblesMessageActionFollowup({
        rawText: 'send it later tonight',
        operation: { kind: 'defer', timingHint: 'today tonight' },
        continuity: selfThreadContinuity,
      }),
    ).toBe(true);
    expect(
      canUseBareBlueBubblesMessageActionFollowup({
        rawText: 'send it',
        operation: { kind: 'send' },
        continuity: selfThreadContinuity,
      }),
    ).toBe(false);
    expect(
      canUseBareBlueBubblesMessageActionFollowup({
        rawText: 'show it again',
        operation: { kind: 'show_draft' },
        continuity: groupContinuity,
      }),
    ).toBe(true);
    expect(
      canUseBareBlueBubblesMessageActionFollowup({
        rawText: 'send it later tonight',
        operation: { kind: 'defer', timingHint: 'today tonight' },
        continuity: groupContinuity,
      }),
    ).toBe(false);
  });

  it('parses an explicit BlueBubbles text-message request with a named target', () => {
    expect(
      parseExplicitBlueBubblesThreadSendIntent(
        'send a text message to Rad Dad: Hey everyone, just looping in.',
      ),
    ).toEqual({
      targetLabel: 'Rad Dad',
      draftText: 'Hey everyone, just looping in.',
    });
  });

  it('resolves a unique synced BlueBubbles chat name for explicit thread sends', () => {
    storeChatMetadata(
      'bb:iMessage;+;chat-rad-dad',
      '2026-04-10T18:59:25.530Z',
      'Rad Dad',
      'bluebubbles',
      true,
    );
    storeChatMetadata(
      'bb:iMessage;-;+14695405551',
      '2026-04-10T19:01:34.886Z',
      'Jeff',
      'bluebubbles',
      false,
    );

    const resolved = resolveBlueBubblesThreadTargetByName(
      'the Rad Dad test thread',
    );
    expect(resolved.state).toBe('resolved');
    if (resolved.state !== 'resolved') {
      throw new Error('expected resolved target');
    }
    expect(resolved.target.chatJid).toBe('bb:iMessage;+;chat-rad-dad');
    expect(resolved.target.displayName).toBe('Rad Dad');
    expect(resolved.target.isGroup).toBe(true);
  });

  it('keeps resolving a synced BlueBubbles thread after placeholder metadata updates', () => {
    storeChatMetadata(
      'bb:iMessage;+;chat-pops',
      '2026-04-10T18:59:25.530Z',
      'Pops of Punk',
      'bluebubbles',
      true,
    );
    storeChatMetadata(
      'bb:iMessage;+;chat-pops',
      '2026-04-10T19:01:34.886Z',
      'bb:iMessage;+;chat-pops',
      'bluebubbles',
      true,
    );

    const resolved = resolveBlueBubblesThreadTargetByName(
      'the Pops of Punk text thread',
    );
    expect(resolved.state).toBe('resolved');
    if (resolved.state !== 'resolved') {
      throw new Error('expected resolved target');
    }
    expect(resolved.target.chatJid).toBe('bb:iMessage;+;chat-pops');
    expect(resolved.target.displayName).toBe('Pops of Punk');
  });

  it('can create an explicit BlueBubbles thread draft without falling back to self-companion mode', () => {
    const action = createOrRefreshMessageActionFromDraft({
      groupFolder: 'main',
      presentationChannel: 'bluebubbles',
      presentationChatJid: 'bb:iMessage;-;+14695405551',
      sourceType: 'manual_prompt',
      sourceKey: 'bluebubbles-thread-send:bb:iMessage;+;chat-rad-dad:hey',
      sourceSummary: 'Draft text message to Rad Dad.',
      draftText: 'Hey everyone, I am Andrea.',
      personName: 'Rad Dad',
      threadTitle: 'Rad Dad',
      communicationContext: 'general',
      targetOverride: {
        kind: 'external_thread',
        chatJid: 'bb:iMessage;+;chat-rad-dad',
        threadId: null,
        replyToMessageId: null,
        isGroup: true,
        personName: 'Rad Dad',
      },
      targetChannelOverride: 'bluebubbles',
      now: new Date('2026-04-10T19:05:00.000Z'),
    });

    expect(action.targetChannel).toBe('bluebubbles');
    expect(action.targetKind).toBe('external_thread');
    expect(action.sendStatus).toBe('drafted');
    expect(action.trustLevel).toBe('draft_only');
  });

  it('treats natural show-draft phrasing as a message-action follow-up', () => {
    expect(
      interpretMessageActionFollowup("ok let's see the draft again"),
    ).toEqual({
      kind: 'show_draft',
    });
    expect(interpretMessageActionFollowup('show me the draft again')).toEqual({
      kind: 'show_draft',
    });
  });
});
