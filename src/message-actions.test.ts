import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _closeDatabase,
  _initTestDatabase,
  getCommunicationThread,
  getMessageAction,
  getOutcomeBySource,
  getTaskById,
  listAssistantMetricEvents,
  listCognitiveRewardSignals,
  storeChatMetadata,
  storeMessageDirect,
  updateMessageAction,
  upsertCommunicationThread,
  upsertDelegationRule,
  upsertToolReliabilityRollup,
} from './db.js';
import { getBlueBubblesCanonicalSelfThreadJid } from './bluebubbles-self-thread.js';
import {
  MESSAGE_ACTION_FOLLOWUP_CONTEXT_TTL_MS,
  applyMessageActionOperation,
  buildBlueBubblesProofDrillPresentationText,
  buildMessageActionPresentation,
  canUseBareBlueBubblesMessageActionFollowup,
  createOrRefreshMessageActionFromDraft,
  ensureBlueBubblesSelfThreadMessageActionForReplyText,
  executeExplicitlyAuthorizedMessageAction,
  findLatestChatMessageAction,
  isBlueBubblesProofDrillAction,
  isBlueBubblesExplicitSendAlias,
  isMessageActionBoundToPresentationSurface,
  isMessageActionBoundToPresentationMessage,
  interpretMessageActionFollowup,
  linkMessageActionCognitiveContext,
  listBlueBubblesMessageActionContinuitySnapshots,
  parseExplicitBlueBubblesThreadSendIntent,
  reconcileBlueBubblesMessageActionContinuity,
  reconcileBlueBubblesSelfThreadContinuity,
  resolveBlueBubblesProofDrillSnapshot,
  resolveBlueBubblesThreadTargetByName,
  resolveMessageActionForFollowup,
  runScheduledMessageActionByTaskId,
  startBlueBubblesProofDrill,
  validateMessageActionFollowupContext,
} from './message-actions.js';
import {
  beginCognitiveKernelRun,
  finalizeCognitiveKernelOutcome,
} from './cognitive-kernel.js';
import {
  resolveQueuedMessagingOwnerAuthorizationAt,
  setMessagingOutboundPaused,
  validateMessagingOutboundAuthorizationFence,
} from './messaging-outbound-pause.js';
import { ChannelDeliveryRejectedBeforeDispatchError } from './channel-delivery.js';
import type {
  CommunicationThreadRecord,
  DelegationRuleRecord,
  SendMessageOptions,
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

function confirmMessageActionPresentation(
  action: {
    messageActionId: string;
    presentationChatJid?: string | null;
  },
  presentationMessageId?: string,
): void {
  updateMessageAction(action.messageActionId, {
    presentationMessageId:
      presentationMessageId || `bb:test-card:${action.messageActionId}`,
    presentationThreadId: action.presentationChatJid || null,
  });
}

function configureTestBlueBubblesOwnerSelfThread(): string {
  const chatJid = 'bb:iMessage;-;+12025550199';
  vi.stubEnv('BLUEBUBBLES_CANONICAL_SELF_THREAD_JID', chatJid);
  vi.stubEnv(
    'BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS',
    `${chatJid},bb:iMessage;-;+12025550198`,
  );
  return chatJid;
}

describe('message actions', () => {
  beforeEach(() => {
    _initTestDatabase();
    configureTestBlueBubblesOwnerSelfThread();
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

  it('infers external-thread targets from telegram communication threads', () => {
    const thread = seedCommunicationThread({
      id: 'comm-telegram-1',
      channel: 'telegram',
      channelChatJid: 'tg:alice',
      title: 'Alice',
    });

    const action = createOrRefreshMessageActionFromDraft({
      groupFolder: 'main',
      presentationChannel: 'telegram',
      presentationChatJid: 'tg:alice',
      sourceType: 'communication_thread',
      sourceKey: thread.id,
      sourceSummary: 'Alice asked a quick follow-up.',
      draftText: 'Yes, we are still on.',
      personName: 'Alice',
      threadTitle: thread.title,
      communicationThreadId: thread.id,
      communicationContext: 'reply_followthrough',
      now: new Date('2026-04-08T19:00:00.000Z'),
    });

    expect(action.targetKind).toBe('external_thread');
    expect(action.targetChannel).toBe('telegram');
    expect(action.sendStatus).toBe('drafted');
  });

  it('turns a linked BlueBubbles message decision into one reviewed cognitive outcome', async () => {
    const thread = seedCommunicationThread();
    const action = createOrRefreshMessageActionFromDraft({
      groupFolder: 'main',
      presentationChannel: 'bluebubbles',
      presentationChatJid: 'bb:chat-1',
      sourceType: 'communication_thread',
      sourceKey: `${thread.id}:reviewed`,
      sourceSummary: 'A bounded draft is ready for review.',
      draftText: 'Dinner still works for me tonight.',
      personName: 'Candace',
      threadTitle: 'Candace',
      communicationThreadId: thread.id,
      communicationContext: 'reply_followthrough',
      now: new Date('2026-04-08T19:00:00.000Z'),
    });
    const kernel = beginCognitiveKernelRun({
      turnId: 'message-action-owner-review',
      channel: 'bluebubbles',
      groupFolder: 'main',
      taskFamily: 'communication',
      goal: 'Draft a reply and keep the send approval-gated.',
      requestRoute: 'bluebubbles.direct',
      selectedSkillId: 'communication.reply_help',
      selectedSkillPurpose: 'Draft a safe reply.',
      selectedSkillApprovalNeed: 'explicit',
      selectedSkillSideEffectRisk: 'high',
      selectedSkillEvidenceLevel: 'strong',
    });
    finalizeCognitiveKernelOutcome({
      cognitiveRun: kernel,
      evaluationStatus: 'pass',
      evidenceGap: 'none',
      evaluatorFlags: ['approval_required'],
      routeUsed: 'communication.reply_help',
      answerClass: 'handled',
    });
    linkMessageActionCognitiveContext({
      messageActionId: action.messageActionId,
      cognitiveRunId: kernel.run.runId,
      cognitiveSkillId: kernel.run.linkedSkillCardId,
      cognitiveTrajectoryId: kernel.trajectoryScore.trajectoryId,
      now: new Date('2026-04-08T19:01:00.000Z'),
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await applyMessageActionOperation(
        action.messageActionId,
        { kind: 'keep_draft' },
        {
          groupFolder: 'main',
          channel: 'bluebubbles',
          chatJid: 'bb:chat-1',
          currentTime: new Date('2026-04-08T19:02:00.000Z'),
          sendToTarget: vi.fn(),
        },
      );
    }

    expect(
      listCognitiveRewardSignals({ runId: kernel.run.runId }).filter(
        (signal) => signal.signalKind === 'user_acceptance',
      ),
    ).toHaveLength(1);
    const ownerReviewEvents = listAssistantMetricEvents({
      groupFolder: 'main',
    }).filter((event) => event.kind === 'recommendation_accepted');
    expect(ownerReviewEvents).toHaveLength(1);
    expect(ownerReviewEvents[0]?.metadataJson).toContain(
      '"metricClass":"owner_review"',
    );
    expect(
      JSON.parse(
        getMessageAction(action.messageActionId)?.linkedRefsJson || '{}',
      ),
    ).toMatchObject({
      cognitiveRunId: kernel.run.runId,
      cognitiveOwnerReviewSignalId: expect.any(String),
    });
  });

  it('finds the latest self-thread message action across BlueBubbles self-thread aliases', () => {
    const action = createOrRefreshMessageActionFromDraft({
      groupFolder: 'main',
      presentationChannel: 'bluebubbles',
      presentationChatJid: 'bb:iMessage;-;+12025550199',
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
        chatJid: 'bb:iMessage;-;+12025550198',
        now: new Date('2026-04-16T16:20:00.000Z'),
      })?.messageActionId,
    ).toBe(action.messageActionId);
    updateMessageAction(action.messageActionId, {
      presentationMessageId: 'bb:self-thread-action-card',
    });
    expect(
      resolveMessageActionForFollowup({
        groupFolder: 'main',
        chatJid: 'bb:iMessage;-;+12025550198',
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
      'bb:iMessage;-;+12025550198',
      '2026-04-16T16:06:22.703Z',
      'Jeff',
      'bluebubbles',
      false,
    );
    storeMessageDirect({
      id: 'bb:self-thread-draft-1',
      chat_jid: 'bb:iMessage;-;+12025550198',
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
      chatJid: 'bb:iMessage;-;+12025550199',
      rawText: 'send it later tonight',
      now: new Date('2026-04-16T16:20:00.000Z'),
    });

    expect(action?.messageActionId).toBeTruthy();
    expect(action?.presentationChatJid).toBe(
      getBlueBubblesCanonicalSelfThreadJid(),
    );
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
      'bb:iMessage;-;+12025550198',
      '2026-04-16T16:06:22.703Z',
      'Jeff',
      'bluebubbles',
      false,
    );

    const action = ensureBlueBubblesSelfThreadMessageActionForReplyText({
      groupFolder: 'main',
      chatJid: 'bb:iMessage;-;+12025550198',
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
    expect(action?.presentationChatJid).toBe(
      getBlueBubblesCanonicalSelfThreadJid(),
    );
    expect(action?.presentationMessageId).toBe('bb:self-thread-draft-ensure');
    expect(action?.draftText).toBe('Hey Candace, tonight still works for me.');
  });

  it('collapses duplicate same-thread BlueBubbles drafts to one active action', () => {
    const older = createOrRefreshMessageActionFromDraft({
      groupFolder: 'main',
      presentationChannel: 'bluebubbles',
      presentationChatJid: 'bb:iMessage;-;+12025550199',
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
      presentationChatJid: 'bb:iMessage;-;+12025550199',
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
      chatJid: 'bb:iMessage;-;+12025550198',
      now: new Date('2026-04-16T16:10:00.000Z'),
      allowRehydrate: false,
    });

    expect(continuity.activeMessageActionId).toBe(newer.messageActionId);
    expect(continuity.openMessageActionCount).toBe(1);
    expect(continuity.supersededActionIds).toContain(older.messageActionId);
    expect(getMessageAction(older.messageActionId)?.sendStatus).toBe('skipped');
    expect(getMessageAction(newer.messageActionId)?.sendStatus).toBe('drafted');
  });

  it('keeps case-different same-target self-thread drafts distinct and fails closed', () => {
    const sharedParams = {
      groupFolder: 'main',
      presentationChannel: 'bluebubbles' as const,
      presentationChatJid: 'bb:iMessage;-;+12025550199',
      sourceType: 'manual_prompt' as const,
      personName: 'Candace',
      threadTitle: 'Candace',
      communicationContext: 'general' as const,
      targetOverride: {
        kind: 'external_thread' as const,
        chatJid: 'bb:iMessage;+;chat-candace',
        threadId: null,
        replyToMessageId: null,
        isGroup: false,
        personName: 'Candace',
      },
      targetChannelOverride: 'bluebubbles' as const,
    };
    const older = createOrRefreshMessageActionFromDraft({
      ...sharedParams,
      sourceKey: 'case-distinct-self-thread-older',
      sourceSummary: 'First same-target draft.',
      draftText: 'Tonight still works for me.',
      now: new Date('2026-04-16T16:00:00.000Z'),
    });
    const newer = createOrRefreshMessageActionFromDraft({
      ...sharedParams,
      sourceKey: 'case-distinct-self-thread-newer',
      sourceSummary: 'Second same-target draft.',
      draftText: 'tonight still works for me.',
      now: new Date('2026-04-16T16:05:00.000Z'),
    });

    const continuity = reconcileBlueBubblesSelfThreadContinuity({
      groupFolder: 'main',
      chatJid: 'bb:iMessage;-;+12025550198',
      now: new Date('2026-04-16T16:10:00.000Z'),
      allowRehydrate: false,
    });

    expect(continuity.openMessageActionCount).toBe(2);
    expect(continuity.supersededActionIds).not.toContain(older.messageActionId);
    expect(getMessageAction(older.messageActionId)?.sendStatus).toBe('drafted');
    expect(getMessageAction(newer.messageActionId)?.sendStatus).toBe('drafted');
    expect(
      resolveMessageActionForFollowup({
        groupFolder: 'main',
        chatJid: 'bb:iMessage;-;+12025550198',
        rawText: 'make it shorter',
        now: new Date('2026-04-16T16:10:00.000Z'),
      }),
    ).toBeUndefined();
  });

  it('skips stale self-thread BlueBubbles actions when no fresh draft remains', () => {
    const stale = createOrRefreshMessageActionFromDraft({
      groupFolder: 'main',
      presentationChannel: 'bluebubbles',
      presentationChatJid: 'bb:iMessage;-;+12025550199',
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
      chatJid: 'bb:iMessage;-;+12025550198',
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
        chatJid: 'bb:iMessage;-;+12025550198',
      }),
    ).toBeUndefined();
  });

  it('starts one active BlueBubbles proof drill action and refreshes it on repeat start', () => {
    const canonicalSelfThreadJid = configureTestBlueBubblesOwnerSelfThread();
    const first = startBlueBubblesProofDrill({
      groupFolder: 'main',
      chatJid: 'bb:iMessage;-;+12025550198',
      now: new Date('2026-04-16T16:00:00.000Z'),
    });
    const second = startBlueBubblesProofDrill({
      groupFolder: 'main',
      chatJid: canonicalSelfThreadJid,
      now: new Date('2026-04-16T16:05:00.000Z'),
    });
    const snapshot = resolveBlueBubblesProofDrillSnapshot({
      groupFolder: 'main',
      now: new Date('2026-04-16T16:05:00.000Z'),
    });
    const continuity = reconcileBlueBubblesSelfThreadContinuity({
      groupFolder: 'main',
      chatJid: canonicalSelfThreadJid,
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
    expect(
      buildMessageActionPresentation(second.action, 'telegram')
        .inlineActionRows.flat()
        .map((control) => control.label),
    ).toEqual(['Send later tonight']);
    expect(
      buildMessageActionPresentation(second.action, 'telegram').text,
    ).toContain('say `send it later tonight`');
    expect(
      buildMessageActionPresentation(second.action, 'telegram').text,
    ).not.toContain('make it more direct');
  });

  it('keeps BlueBubbles proof drills deferred-only and rejects immediate send', async () => {
    configureTestBlueBubblesOwnerSelfThread();
    const started = startBlueBubblesProofDrill({
      groupFolder: 'main',
      now: new Date('2026-04-16T16:00:00.000Z'),
    });
    const sendToTarget = vi.fn(async () => ({ platformMessageId: 'unused' }));
    confirmMessageActionPresentation(started.action);

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
      listAssistantMetricEvents({ groupFolder: 'main' }).filter(
        (event) => event.kind === 'recommendation_accepted',
      ),
    ).toHaveLength(0);
    expect(
      resolveBlueBubblesProofDrillSnapshot({
        groupFolder: 'main',
        now: new Date('2026-04-16T16:02:00.000Z'),
      }).proofDrillState,
    ).toBe('deferred');
  });

  it('records late-night BlueBubbles proof drill deferral without requiring a schedulable reminder', async () => {
    configureTestBlueBubblesOwnerSelfThread();
    const started = startBlueBubblesProofDrill({
      groupFolder: 'main',
      now: new Date('2026-06-16T04:57:00.000Z'),
    });
    const sendToTarget = vi.fn(async () => ({ platformMessageId: 'unused' }));
    confirmMessageActionPresentation(started.action);

    const deferred = await applyMessageActionOperation(
      started.action.messageActionId,
      { kind: 'defer', timingHint: 'later tonight' },
      {
        groupFolder: 'main',
        channel: 'bluebubbles',
        chatJid: started.action.presentationChatJid || '',
        currentTime: new Date('2026-06-16T04:58:00.000Z'),
        sendToTarget,
      },
    );

    expect(deferred.action?.sendStatus).toBe('deferred');
    expect(deferred.action?.lastActionKind).toBe('remind_instead');
    expect(deferred.action?.followupAt).toBeNull();
    expect(deferred.action?.scheduledTaskId).toBeNull();
    expect(deferred.replyText).toContain('deferred decision is recorded');
    expect(sendToTarget).not.toHaveBeenCalled();
    expect(
      resolveBlueBubblesProofDrillSnapshot({
        groupFolder: 'main',
        now: new Date('2026-06-16T04:58:00.000Z'),
      }).proofDrillState,
    ).toBe('deferred');
  });

  it('prefers a fresh rehydrated self-thread draft over a stale older action', () => {
    const stale = createOrRefreshMessageActionFromDraft({
      groupFolder: 'main',
      presentationChannel: 'bluebubbles',
      presentationChatJid: 'bb:iMessage;-;+12025550199',
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
      'bb:iMessage;-;+12025550198',
      '2026-04-16T16:06:22.703Z',
      'Jeff',
      'bluebubbles',
      false,
    );
    storeMessageDirect({
      id: 'bb:self-thread-draft-fresh',
      chat_jid: 'bb:iMessage;-;+12025550198',
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
      chatJid: 'bb:iMessage;-;+12025550199',
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
      'bb:iMessage;-;+12025550104',
      '2026-04-16T18:05:00.000Z',
      'Candace',
      'bluebubbles',
      false,
    );
    storeMessageDirect({
      id: 'bb:direct-recent-andrea',
      chat_jid: 'bb:iMessage;-;+12025550104',
      sender: 'Andrea',
      sender_name: 'Andrea',
      content: 'Andrea: Here is the latest draft option.',
      timestamp: '2026-04-16T18:08:00.000Z',
      is_from_me: true,
      is_bot_message: true,
    });

    const continuity = reconcileBlueBubblesMessageActionContinuity({
      groupFolder: 'main',
      chatJid: 'bb:iMessage;-;+12025550104',
      now: new Date('2026-04-16T18:10:00.000Z'),
      allowRehydrate: true,
    });

    expect(continuity.conversationKind).toBe('direct_1to1');
    expect(continuity.decisionPolicy).toBe('semi_auto_recent_direct_1to1');
    expect(continuity.conversationalEligibility).toBe('conversational_now');
    expect(continuity.requiresExplicitMention).toBe(false);
    expect(continuity.recentTargetChatJid).toBe('bb:iMessage;-;+12025550104');
    expect(
      listBlueBubblesMessageActionContinuitySnapshots({
        groupFolder: 'main',
        now: new Date('2026-04-16T18:10:00.000Z'),
        allowRehydrate: true,
      }).some(
        (snapshot) =>
          snapshot.recentTargetChatJid === 'bb:iMessage;-;+12025550104' &&
          snapshot.decisionPolicy === 'semi_auto_recent_direct_1to1',
      ),
    ).toBe(true);
  });

  it('keeps stale direct 1:1 BlueBubbles continuity explicit-only when Andrea context is no longer fresh', () => {
    storeChatMetadata(
      'bb:iMessage;-;+12025550104',
      '2026-04-16T16:05:00.000Z',
      'Candace',
      'bluebubbles',
      false,
    );
    storeMessageDirect({
      id: 'bb:direct-stale-andrea',
      chat_jid: 'bb:iMessage;-;+12025550104',
      sender: 'Andrea',
      sender_name: 'Andrea',
      content: 'Andrea: Here is the latest draft option.',
      timestamp: '2026-04-16T16:00:00.000Z',
      is_from_me: true,
      is_bot_message: true,
    });

    const continuity = reconcileBlueBubblesMessageActionContinuity({
      groupFolder: 'main',
      chatJid: 'bb:iMessage;-;+12025550104',
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
      presentationChatJid: 'bb:iMessage;-;+12025550199',
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

  it('keeps bluebubbles replies approval-gated even when a saved send rule matches', () => {
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

    expect(action.sendStatus).toBe('drafted');
    expect(action.requiresApproval).toBe(true);
    expect(action.trustLevel).toBe('approve_before_send');
  });

  it('does not let a saved rule or creation-time approval bypass a separately presented owner approval for an external recipient', () => {
    const thread = seedCommunicationThread({
      id: 'comm-external-fresh-approval',
    });
    seedSendRule({ ruleId: 'rule-external-fresh-approval' });

    const action = createOrRefreshMessageActionFromDraft({
      groupFolder: 'main',
      presentationChannel: 'telegram',
      presentationChatJid: 'tg:main',
      sourceType: 'communication_thread',
      sourceKey: thread.id,
      sourceSummary: 'Candace needs a simple yes/no answer.',
      draftText: 'Yes, tonight still works for me.',
      personName: 'Candace',
      threadTitle: 'Candace',
      communicationThreadId: thread.id,
      communicationContext: 'reply_followthrough',
      explicitApproval: true,
      now: new Date('2026-04-08T19:06:00.000Z'),
    });

    expect(action.targetKind).toBe('external_thread');
    expect(action.sendStatus).toBe('drafted');
    expect(action.requiresApproval).toBe(true);
    expect(action.trustLevel).not.toBe('delegated_safe_send');
    expect(action.approvedAt).toBeNull();
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
    confirmMessageActionPresentation(action);

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

  it('rejects an old Telegram callback authorization even when the action was touched recently', async () => {
    const thread = seedCommunicationThread({ id: 'comm-stale-callback' });
    const action = createOrRefreshMessageActionFromDraft({
      groupFolder: 'main',
      presentationChannel: 'telegram',
      presentationChatJid: 'tg:main',
      sourceType: 'communication_thread',
      sourceKey: thread.id,
      sourceSummary: 'Candace needs a quick answer.',
      draftText: 'Yes, tonight still works for me.',
      personName: 'Candace',
      communicationThreadId: thread.id,
      communicationContext: 'reply_followthrough',
      now: new Date('2026-04-08T20:00:00.000Z'),
    });
    updateMessageAction(action.messageActionId, {
      presentationMessageId: 'tg:old-callback-card',
      lastActionAt: '2026-04-08T20:05:00.000Z',
      lastUpdatedAt: '2026-04-08T20:05:00.000Z',
    });
    const sendToTarget = vi.fn(async () => ({
      platformMessageId: 'must-not-send',
    }));

    const result = await applyMessageActionOperation(
      action.messageActionId,
      { kind: 'send' },
      {
        groupFolder: 'main',
        channel: 'telegram',
        chatJid: 'tg:main',
        currentTime: new Date('2026-04-08T20:10:00.001Z'),
        // Telegram callbacks intentionally carry the original card timestamp.
        ownerAuthorizationAt: '2026-04-08T19:30:00.000Z',
        sendToTarget,
      },
    );

    expect(result.replyText).toContain('too old to authorize');
    expect(result.replyText).toContain('fresh draft');
    expect(sendToTarget).not.toHaveBeenCalled();
    expect(getMessageAction(action.messageActionId)?.sendStatus).toBe(
      'drafted',
    );
  });

  it('rejects a stale natural-language approval with fresh review guidance', async () => {
    const thread = seedCommunicationThread({ id: 'comm-stale-natural-send' });
    const action = createOrRefreshMessageActionFromDraft({
      groupFolder: 'main',
      presentationChannel: 'telegram',
      presentationChatJid: 'tg:main',
      sourceType: 'communication_thread',
      sourceKey: thread.id,
      sourceSummary: 'Candace needs a quick answer.',
      draftText: 'Yes, tonight still works for me.',
      personName: 'Candace',
      communicationThreadId: thread.id,
      communicationContext: 'reply_followthrough',
      now: new Date('2026-04-08T19:00:00.000Z'),
    });
    updateMessageAction(action.messageActionId, {
      presentationMessageId: 'tg:stale-natural-card',
    });
    const now = new Date(
      new Date('2026-04-08T19:00:00.000Z').getTime() +
        MESSAGE_ACTION_FOLLOWUP_CONTEXT_TTL_MS +
        1,
    );

    expect(
      resolveMessageActionForFollowup({
        groupFolder: 'main',
        chatJid: 'tg:main',
        rawText: 'send it',
        replyToMessageId: 'tg:stale-natural-card',
        now,
      }),
    ).toBeUndefined();
    const staleForDenial = resolveMessageActionForFollowup({
      groupFolder: 'main',
      chatJid: 'tg:main',
      rawText: 'send it',
      replyToMessageId: 'tg:stale-natural-card',
      includeStaleForDenial: true,
      now,
    });
    const sendToTarget = vi.fn();
    const result = await applyMessageActionOperation(
      staleForDenial!.messageActionId,
      { kind: 'send' },
      {
        groupFolder: 'main',
        channel: 'telegram',
        chatJid: 'tg:main',
        currentTime: now,
        ownerAuthorizationAt: now.toISOString(),
        sendToTarget,
      },
    );

    expect(staleForDenial?.messageActionId).toBe(action.messageActionId);
    expect(result.replyText).toContain('too old to authorize');
    expect(result.replyText).toContain(
      'review the exact recipient and message',
    );
    expect(sendToTarget).not.toHaveBeenCalled();
  });

  it('validates both the action context and immutable owner-authorization TTL directly', () => {
    const touchedAt = '2026-04-08T19:00:00.000Z';
    const actionClock = {
      lastActionAt: touchedAt,
      lastUpdatedAt: touchedAt,
      createdAt: touchedAt,
    };
    const exactBoundary = new Date(
      Date.parse(touchedAt) + MESSAGE_ACTION_FOLLOWUP_CONTEXT_TTL_MS,
    );

    expect(
      validateMessageActionFollowupContext({
        action: actionClock,
        now: exactBoundary,
        ownerAuthorizationAt: touchedAt,
      }),
    ).toEqual({ ok: true });
    expect(
      validateMessageActionFollowupContext({
        action: actionClock,
        now: new Date(exactBoundary.getTime() + 1),
      }),
    ).toEqual({ ok: false, reason: 'stale_action_context' });
    expect(
      validateMessageActionFollowupContext({
        action: {
          ...actionClock,
          lastActionAt: exactBoundary.toISOString(),
          lastUpdatedAt: exactBoundary.toISOString(),
        },
        now: new Date(exactBoundary.getTime() + 1),
        ownerAuthorizationAt: touchedAt,
      }),
    ).toEqual({ ok: false, reason: 'stale_owner_authorization' });
  });

  it('keeps discarded actions terminal and removes send or edit controls', async () => {
    const thread = seedCommunicationThread({ id: 'comm-discard-terminal' });
    const action = createOrRefreshMessageActionFromDraft({
      groupFolder: 'main',
      presentationChannel: 'telegram',
      presentationChatJid: 'tg:main',
      sourceType: 'communication_thread',
      sourceKey: thread.id,
      sourceSummary: 'Candace needs a quick answer.',
      draftText: 'Yes, tonight still works for me.',
      personName: 'Candace',
      communicationThreadId: thread.id,
      communicationContext: 'reply_followthrough',
      now: new Date('2026-04-08T20:00:00.000Z'),
    });
    const openControls = buildMessageActionPresentation(
      action,
      'telegram',
    ).inlineActionRows.flat();
    expect(openControls.map((control) => control.label)).toEqual([
      'Send now',
      'Discard draft',
    ]);
    updateMessageAction(action.messageActionId, {
      sendStatus: 'skipped',
      requiresApproval: false,
      lastActionKind: 'skipped',
      lastActionAt: '2026-04-08T20:01:00.000Z',
      lastUpdatedAt: '2026-04-08T20:01:00.000Z',
    });
    const discarded = getMessageAction(action.messageActionId)!;
    expect(
      buildMessageActionPresentation(discarded, 'telegram').inlineActionRows,
    ).toEqual([]);
    const sendToTarget = vi.fn(async () => ({
      platformMessageId: 'must-not-send',
    }));

    for (const operation of [
      { kind: 'send' } as const,
      { kind: 'rewrite', style: 'warmer' } as const,
    ]) {
      const result = await applyMessageActionOperation(
        action.messageActionId,
        operation,
        {
          groupFolder: 'main',
          channel: 'telegram',
          chatJid: 'tg:main',
          currentTime: new Date('2026-04-08T20:02:00.000Z'),
          sendToTarget,
        },
      );
      expect(result.replyText).toContain('was discarded');
      expect(result.presentation?.inlineActionRows).toEqual([]);
    }
    const explicitReplay = await executeExplicitlyAuthorizedMessageAction(
      action.messageActionId,
      {
        groupFolder: 'main',
        channel: 'telegram',
        chatJid: 'tg:main',
        currentTime: new Date('2026-04-08T20:03:00.000Z'),
        ownerAuthorizationAt: '2026-04-08T20:03:00.000Z',
        sendToTarget,
      },
    );
    expect(explicitReplay.replyText).toContain('was discarded');
    expect(sendToTarget).not.toHaveBeenCalled();
    expect(getMessageAction(action.messageActionId)).toMatchObject({
      sendStatus: 'skipped',
      draftText: 'Yes, tonight still works for me.',
    });
  });

  it('blocks every external-thread approval operation until any source has a delivered card', async () => {
    const thread = seedCommunicationThread({ id: 'comm-missing-card' });
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
    });
    const sendToTarget = vi.fn();

    for (const operation of [
      { kind: 'send' } as const,
      { kind: 'defer', timingHint: 'tonight' } as const,
      { kind: 'rewrite_and_send', style: 'warmer' } as const,
    ]) {
      const result = await applyMessageActionOperation(
        action.messageActionId,
        operation,
        {
          groupFolder: 'main',
          channel: 'bluebubbles',
          chatJid: 'bb:chat-1',
          sendToTarget,
        },
      );
      expect(result.replyText).toContain(
        'could not verify that the recipient-bound draft card reached',
      );
      expect(result.presentation).toBeTruthy();
    }

    expect(sendToTarget).not.toHaveBeenCalled();
    expect(getMessageAction(action.messageActionId)).toMatchObject({
      sendStatus: 'drafted',
      presentationMessageId: null,
      scheduledTaskId: null,
    });
  });

  it('blocks replay and preserves evidence when channel delivery is partial', async () => {
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
    confirmMessageActionPresentation(action);

    const result = await applyMessageActionOperation(
      action.messageActionId,
      { kind: 'send' },
      {
        groupFolder: 'main',
        channel: 'bluebubbles',
        chatJid: 'bb:chat-1',
        currentTime: new Date('2026-04-08T19:12:00.000Z'),
        sendToTarget: vi.fn(async () => ({
          platformMessageId: 'prefix-only',
          platformMessageIds: ['prefix-only'],
          deliveryState: 'partial' as const,
          nextUnconfirmedChunkIndex: 1,
        })),
      },
    );

    expect(result.handled).toBe(true);
    expect(result.replyText).toContain('could not confirm');
    expect(result.replyText).toContain('will not retry');
    expect(result.presentation?.inlineActionRows).toEqual([]);
    expect(getMessageAction(action.messageActionId)).toMatchObject({
      sendStatus: 'delivery_unverified',
      platformMessageId: 'prefix-only',
      trustLevel: 'never_automate',
      lastActionKind: 'delivery_unverified',
    });
    const stored = getMessageAction(action.messageActionId)!;
    expect(JSON.parse(stored.explanationJson || '{}')).toMatchObject({
      deliveryVerification: {
        outcome: 'partial',
        confirmedReceiptIds: ['prefix-only'],
        confirmedReceiptCount: 1,
        nextUnconfirmedChunkIndex: 1,
        retryPolicy: 'verify_before_resend',
      },
    });
    expect(
      getOutcomeBySource('main', 'message_action', action.messageActionId)
        ?.status,
    ).toBe('partial');

    const retrySend = vi.fn(async () => ({
      platformMessageId: 'must-not-send',
    }));
    const retry = await applyMessageActionOperation(
      action.messageActionId,
      { kind: 'send_again' },
      {
        groupFolder: 'main',
        channel: 'bluebubbles',
        chatJid: 'bb:chat-1',
        currentTime: new Date('2026-04-08T19:13:00.000Z'),
        sendToTarget: retrySend,
      },
    );
    expect(retry.replyText).toContain('will not resend');
    expect(retry.replyText).toContain('create a new draft');
    expect(retrySend).not.toHaveBeenCalled();
  });

  it('keeps receiptless transport uncertainty distinct from a failed send', async () => {
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
    confirmMessageActionPresentation(action);

    await applyMessageActionOperation(
      action.messageActionId,
      { kind: 'send' },
      {
        groupFolder: 'main',
        channel: 'bluebubbles',
        chatJid: 'bb:chat-1',
        currentTime: new Date('2026-04-08T19:12:00.000Z'),
        sendToTarget: vi.fn(async () => ({
          deliveryState: 'unknown' as const,
          nextUnconfirmedChunkIndex: 0,
        })),
      },
    );

    const stored = getMessageAction(action.messageActionId)!;
    expect(stored).toMatchObject({
      sendStatus: 'delivery_unverified',
      platformMessageId: null,
    });
    expect(JSON.parse(stored.explanationJson || '{}')).toMatchObject({
      deliveryVerification: {
        outcome: 'unknown',
        confirmedReceiptIds: [],
        confirmedReceiptCount: 0,
        nextUnconfirmedChunkIndex: 0,
      },
    });
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

  it('requires a fresh BlueBubbles action instead of reusing a sent idempotency key', async () => {
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
    confirmMessageActionPresentation(action);

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
    const sendAgain = await applyMessageActionOperation(
      action.messageActionId,
      { kind: 'send_again' },
      {
        groupFolder: 'main',
        channel: 'bluebubbles',
        chatJid: 'bb:chat-1',
        currentTime: new Date('2026-04-08T19:23:00.000Z'),
        sendToTarget,
      },
    );

    expect(duplicate.replyText).toContain('already went out');
    expect(sendAgain.replyText).toContain('fresh message action');
    expect(sendAgain.replyText).toContain('idempotency key');
    expect(
      sendAgain.presentation?.inlineActionRows
        .flat()
        .map((control) => control.label),
    ).not.toContain('Send again');
    expect(sendToTarget).toHaveBeenCalledTimes(1);
  });

  it('collapses concurrent approvals into one outbound delivery attempt', async () => {
    const thread = seedCommunicationThread();
    const action = createOrRefreshMessageActionFromDraft({
      groupFolder: 'main',
      presentationChannel: 'telegram',
      presentationChatJid: 'tg:main',
      sourceType: 'communication_thread',
      sourceKey: `${thread.id}:concurrent-send`,
      sourceSummary: 'Candace still needs a quick answer.',
      draftText: 'Yes, tonight still works.',
      personName: 'Candace',
      threadTitle: 'Candace',
      communicationThreadId: thread.id,
      communicationContext: 'reply_followthrough',
      forceApproval: true,
      now: new Date('2026-04-08T19:20:00.000Z'),
    });
    confirmMessageActionPresentation(action, 'tg:concurrent-send-card');
    let releaseDelivery: (() => void) | undefined;
    const deliveryGate = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    const sendToTarget = vi.fn(async () => {
      await deliveryGate;
      return { platformMessageId: 'bb:sent-concurrent' };
    });
    const deps = {
      groupFolder: 'main',
      channel: 'telegram' as const,
      chatJid: 'tg:main',
      currentTime: new Date('2026-04-08T19:21:00.000Z'),
      sendToTarget,
    };

    const first = applyMessageActionOperation(
      action.messageActionId,
      { kind: 'send' },
      deps,
    );
    const second = applyMessageActionOperation(
      action.messageActionId,
      { kind: 'send' },
      deps,
    );
    await vi.waitFor(() => expect(sendToTarget).toHaveBeenCalledTimes(1));
    releaseDelivery?.();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult.action?.sendStatus).toBe('sent');
    expect(secondResult.action?.sendStatus).toBe('sent');
    expect(firstResult.replyText).toBe(secondResult.replyText);
    expect(getMessageAction(action.messageActionId)?.sendStatus).toBe('sent');
    expect(sendToTarget).toHaveBeenCalledTimes(1);
  });

  it('binds interactive message actions to the exact owner presentation surface', () => {
    vi.stubEnv('ANDREA_TEST_DISABLE_OWNER_ENV_FILE', '1');
    vi.stubEnv(
      'BLUEBUBBLES_CANONICAL_SELF_THREAD_JID',
      'iMessage;-;owner@example.invalid',
    );
    vi.stubEnv('BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS', 'SMS;-;+12025550109');

    expect(
      isMessageActionBoundToPresentationSurface({
        action: { presentationChatJid: 'tg:main' },
        channel: 'telegram',
        chatJid: 'tg:main',
      }),
    ).toBe(true);
    expect(
      isMessageActionBoundToPresentationSurface({
        action: { presentationChatJid: 'tg:main' },
        channel: 'telegram',
        chatJid: 'tg:other',
      }),
    ).toBe(false);
    expect(
      isMessageActionBoundToPresentationSurface({
        action: {
          presentationChatJid: 'bb:iMessage;-;owner@example.invalid',
        },
        channel: 'bluebubbles',
        chatJid: 'bb:SMS;-;+12025550109',
      }),
    ).toBe(true);
    expect(
      isMessageActionBoundToPresentationSurface({
        action: {
          presentationChatJid: 'bb:iMessage;-;owner@example.invalid',
        },
        channel: 'bluebubbles',
        chatJid: 'bb:iMessage;-;stranger@example.invalid',
      }),
    ).toBe(false);
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
    confirmMessageActionPresentation(action);

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

  it('does not queue a scheduled send while the owner pause is active', async () => {
    vi.stubEnv('BLUEBUBBLES_SEND_ENABLED', 'true');
    setMessagingOutboundPaused({
      paused: true,
      changedByChatJid: 'tg:owner',
      reason: 'owner_natural_language_pause',
      now: new Date('2026-04-08T19:25:30.000Z'),
    });
    const thread = seedCommunicationThread({ id: 'comm-paused-schedule' });
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
    const sendToTarget = vi.fn(async () => ({
      platformMessageId: 'must-not-send',
    }));
    confirmMessageActionPresentation(action);

    const result = await applyMessageActionOperation(
      action.messageActionId,
      { kind: 'defer' },
      {
        groupFolder: 'main',
        channel: 'bluebubbles',
        chatJid: 'bb:chat-1',
        currentTime: new Date('2026-04-08T19:26:00.000Z'),
        sendToTarget,
      },
    );

    const updated = getMessageAction(action.messageActionId)!;
    expect(result.handled).toBe(true);
    expect(result.replyText).toContain('paused by the owner');
    expect(updated.sendStatus).toBe('deferred');
    expect(updated.scheduledTaskId).toBeNull();
    expect(sendToTarget).not.toHaveBeenCalled();
  });

  it('does not execute an immediate send while the owner pause is active', async () => {
    setMessagingOutboundPaused({
      paused: true,
      changedByChatJid: 'tg:owner',
      reason: 'owner_natural_language_pause',
    });
    const thread = seedCommunicationThread({ id: 'comm-paused-immediate' });
    const action = createOrRefreshMessageActionFromDraft({
      groupFolder: 'main',
      presentationChannel: 'telegram',
      presentationChatJid: 'tg:main',
      sourceType: 'communication_thread',
      sourceKey: thread.id,
      sourceSummary: 'Candace needs a quick answer.',
      draftText: 'Yes, tonight still works for me.',
      personName: 'Candace',
      threadTitle: 'Candace',
      communicationThreadId: thread.id,
      communicationContext: 'reply_followthrough',
    });
    const sendToTarget = vi.fn(async () => ({
      platformMessageId: 'must-not-send',
    }));
    confirmMessageActionPresentation(action, 'tg:paused-send-card');

    const result = await applyMessageActionOperation(
      action.messageActionId,
      { kind: 'send' },
      {
        groupFolder: 'main',
        channel: 'telegram',
        chatJid: 'tg:main',
        sendToTarget,
      },
    );

    expect(result.handled).toBe(true);
    expect(result.replyText).toContain('paused by the owner');
    expect(sendToTarget).not.toHaveBeenCalled();
    expect(getMessageAction(action.messageActionId)?.sendStatus).toBe(
      'drafted',
    );
  });

  it('keeps a queued pre-stop send-it approval stale after resume while allowing a fresh followup', async () => {
    const makeAction = (suffix: string) => {
      const thread = seedCommunicationThread({
        id: `comm-queued-approval-${suffix}`,
      });
      const action = createOrRefreshMessageActionFromDraft({
        groupFolder: 'main',
        presentationChannel: 'telegram',
        presentationChatJid: 'tg:main',
        sourceType: 'communication_thread',
        sourceKey: thread.id,
        sourceSummary: 'Candace needs a quick answer.',
        draftText: 'Yes, tonight still works for me.',
        personName: 'Candace',
        threadTitle: 'Candace',
        communicationThreadId: thread.id,
        communicationContext: 'reply_followthrough',
        now: new Date('2026-04-08T19:40:00.000Z'),
      });
      confirmMessageActionPresentation(
        action,
        `tg:queued-approval-card-${suffix}`,
      );
      return action;
    };
    setMessagingOutboundPaused({
      paused: true,
      changedByChatJid: 'tg:owner',
      reason: 'owner_stop_after_queued_approval',
      now: new Date('2026-04-08T19:50:00.000Z'),
    });
    setMessagingOutboundPaused({
      paused: false,
      changedByChatJid: 'tg:owner',
      reason: 'owner_resume_after_queued_approval',
      now: new Date('2026-04-08T19:55:00.000Z'),
    });
    let providerPostCount = 0;
    const sendToBoundary = vi.fn(
      async (_targetChannel, _chatJid, _text, options) => {
        const validation = validateMessagingOutboundAuthorizationFence({
          authorizationAt: options?.blueBubblesAuthorizationAt || '',
          pauseGeneration: options?.blueBubblesPauseGeneration ?? -1,
        });
        if (!validation.ok) {
          throw new ChannelDeliveryRejectedBeforeDispatchError(
            validation.reason || 'stale owner authorization',
          );
        }
        providerPostCount += 1;
        return { platformMessageId: `bb:provider-${providerPostCount}` };
      },
    );

    const staleAction = makeAction('stale');
    const delayedPreStopTelegramAuthorization =
      resolveQueuedMessagingOwnerAuthorizationAt('telegram', {
        timestamp: '2026-04-08T19:45:00.000Z',
        // The bot first persisted/drained this delayed update after resume.
        ingress_received_at: '2026-04-08T20:00:00.000Z',
      });
    const stale = await applyMessageActionOperation(
      staleAction.messageActionId,
      { kind: 'send' },
      {
        groupFolder: 'main',
        channel: 'telegram',
        chatJid: 'tg:main',
        currentTime: new Date('2026-04-08T20:00:00.000Z'),
        ownerAuthorizationAt: delayedPreStopTelegramAuthorization,
        sendToTarget: sendToBoundary,
      },
    );
    expect(stale.replyText).toContain("couldn't send");
    expect(providerPostCount).toBe(0);
    expect(sendToBoundary).toHaveBeenLastCalledWith(
      'bluebubbles',
      expect.any(String),
      expect.any(String),
      expect.objectContaining({
        blueBubblesAuthorizationAt: '2026-04-08T19:45:00.000Z',
        blueBubblesPauseGeneration: 1,
      }),
    );

    const freshAction = makeAction('fresh');
    const freshPostResumeTelegramAuthorization =
      resolveQueuedMessagingOwnerAuthorizationAt('telegram', {
        timestamp: '2026-04-08T19:55:00.001Z',
        ingress_received_at: '2026-04-08T20:01:00.000Z',
      });
    const fresh = await applyMessageActionOperation(
      freshAction.messageActionId,
      { kind: 'send' },
      {
        groupFolder: 'main',
        channel: 'telegram',
        chatJid: 'tg:main',
        currentTime: new Date('2026-04-08T20:01:00.000Z'),
        ownerAuthorizationAt: freshPostResumeTelegramAuthorization,
        sendToTarget: sendToBoundary,
      },
    );
    expect(fresh.action?.sendStatus).toBe('sent');
    expect(providerPostCount).toBe(1);
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
    confirmMessageActionPresentation(action);

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

  it('stops claiming exact owner text after a draft rewrite', async () => {
    const action = createOrRefreshMessageActionFromDraft({
      groupFolder: 'main',
      presentationChannel: 'telegram',
      presentationChatJid: 'tg:main',
      sourceType: 'manual_prompt',
      sourceKey: 'owner-literal-rewrite-provenance',
      sourceSummary: 'Owner supplied the initial exact text.',
      draftProvenance: 'owner_literal',
      draftText: 'Just wanted to ask if seven still works.',
      personName: 'Candace',
      forceApproval: true,
      targetOverride: {
        kind: 'external_thread',
        chatJid: 'bb:iMessage;-;+12025550123',
        isGroup: false,
        personName: 'Candace',
      },
      targetChannelOverride: 'bluebubbles',
      now: new Date('2026-04-08T19:34:00.000Z'),
    });
    expect(buildMessageActionPresentation(action, 'telegram').text).toContain(
      'Andrea: I staged your exact text.',
    );
    confirmMessageActionPresentation(action, 'tg:owner-literal-card');

    const result = await applyMessageActionOperation(
      action.messageActionId,
      { kind: 'rewrite', style: 'more_direct' },
      {
        groupFolder: 'main',
        channel: 'telegram',
        chatJid: 'tg:main',
        currentTime: new Date('2026-04-08T19:35:00.000Z'),
        sendToTarget: vi.fn(),
      },
    );

    expect(result.presentation?.text).toContain('Andrea: I drafted a reply.');
    expect(result.presentation?.text).not.toContain(
      'Andrea: I staged your exact text.',
    );
    expect(JSON.parse(result.action?.explanationJson || '{}')).toMatchObject({
      draftProvenance: 'assistant_authored',
    });
    expect(result.action).toMatchObject({
      sendStatus: 'drafted',
      requiresApproval: true,
      lastActionKind: 'rewrite',
      presentationMessageId: null,
    });
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
    updateMessageAction(action.messageActionId, {
      presentationMessageId: 'bb:pre-rewrite-card',
      presentationThreadId: 'bb:pre-rewrite-thread',
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
    expect(updated.presentationMessageId).toBeNull();
    expect(updated.presentationThreadId).toBeNull();
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
    confirmMessageActionPresentation(action);

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

  it('keeps rewrite-and-send unsent and requires fresh review of the changed card', async () => {
    const thread = seedCommunicationThread({
      id: 'comm-rewrite-and-send-review',
      channelChatJid: 'bb:rewrite-and-send-target',
    });
    const action = createOrRefreshMessageActionFromDraft({
      groupFolder: 'main',
      presentationChannel: 'telegram',
      presentationChatJid: 'tg:main',
      presentationThreadId: 'topic-review',
      sourceType: 'communication_thread',
      sourceKey: thread.id,
      sourceSummary: 'Candace needs a concise answer.',
      draftText:
        'Yes, tonight still works. I would also be glad to meet at seven.',
      personName: 'Candace',
      threadTitle: 'Candace',
      communicationThreadId: thread.id,
      communicationContext: 'reply_followthrough',
      now: new Date('2026-04-08T19:38:00.000Z'),
    });
    updateMessageAction(action.messageActionId, {
      presentationMessageId: 'tg:old-rewrite-and-send-card',
      presentationThreadId: 'topic-review',
    });
    const sendToTarget = vi.fn(async () => ({
      platformMessageId: 'must-not-send',
    }));

    const result = await applyMessageActionOperation(
      action.messageActionId,
      { kind: 'rewrite_and_send', style: 'shorter' },
      {
        groupFolder: 'main',
        channel: 'telegram',
        chatJid: 'tg:main',
        currentTime: new Date('2026-04-08T19:39:00.000Z'),
        sendToTarget,
      },
    );

    const updated = getMessageAction(action.messageActionId)!;
    expect(result.handled).toBe(true);
    expect(sendToTarget).not.toHaveBeenCalled();
    expect(updated).toMatchObject({
      draftText: 'Yes, tonight still works.',
      sendStatus: 'drafted',
      requiresApproval: true,
      approvedAt: null,
      presentationMessageId: null,
      presentationThreadId: null,
      platformMessageId: null,
      sentAt: null,
      lastActionKind: 'rewrite',
    });
    expect(result.replyText).toContain('kept the changed draft unsent');
    expect(result.replyText).toContain('approve it separately');
    expect(result.presentation?.primaryMessageActionId).toBe(
      action.messageActionId,
    );
    expect(
      isMessageActionBoundToPresentationMessage({
        action: updated,
        presentationMessageId: 'tg:old-rewrite-and-send-card',
        presentationThreadId: 'topic-review',
      }),
    ).toBe(false);
  });

  it('fences the old card and blocks sends until a pending rewrite gets a fresh presentation', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    vi.stubEnv('OPENAI_BASE_URL', 'https://openai.test/v1');
    let releaseRewrite: (() => void) | undefined;
    const rewriteGate = new Promise<void>((resolve) => {
      releaseRewrite = resolve;
    });
    globalThis.fetch = vi.fn(async () => {
      await rewriteGate;
      return new Response(
        JSON.stringify({
          output_text:
            '{"draftText":"Hey Candace, a stale warmer rewrite must not replace the posted bytes."}',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }) as typeof fetch;

    const thread = seedCommunicationThread();
    const originalText = 'Yes, the original dinner plan still works.';
    const action = createOrRefreshMessageActionFromDraft({
      groupFolder: 'main',
      presentationChannel: 'bluebubbles',
      presentationChatJid: 'bb:chat-1',
      sourceType: 'communication_thread',
      sourceKey: `${thread.id}:stale-rewrite-vs-post`,
      sourceSummary: 'Candace still needs the original dinner answer.',
      draftText: originalText,
      personName: 'Candace',
      threadTitle: 'Candace',
      communicationThreadId: thread.id,
      communicationContext: 'reply_followthrough',
      now: new Date('2026-04-08T19:38:00.000Z'),
    });
    updateMessageAction(action.messageActionId, {
      presentationMessageId: 'bb:original-rewrite-card',
      presentationThreadId: 'bb:self-thread',
    });

    const rewrite = applyMessageActionOperation(
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
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1));
    const fencedRewrite = getMessageAction(action.messageActionId)!;
    expect(fencedRewrite.presentationMessageId).toBeNull();
    expect(
      isMessageActionBoundToPresentationMessage({
        action: fencedRewrite,
        presentationMessageId: 'bb:original-rewrite-card',
        presentationThreadId: 'bb:self-thread',
      }),
    ).toBe(false);

    const sendToTarget = vi.fn();
    const blockedSend = await applyMessageActionOperation(
      action.messageActionId,
      { kind: 'send' },
      {
        groupFolder: 'main',
        channel: 'bluebubbles',
        chatJid: 'bb:chat-1',
        currentTime: new Date('2026-04-08T19:40:00.000Z'),
        sendToTarget,
      },
    );
    expect(sendToTarget).not.toHaveBeenCalled();
    expect(blockedSend.replyText).toContain(
      'could not verify that the recipient-bound draft card reached',
    );
    expect(blockedSend.action).toMatchObject({
      sendStatus: 'drafted',
      draftText: originalText,
      presentationMessageId: null,
    });

    releaseRewrite?.();
    const rewritten = await rewrite;
    expect(rewritten.action).toMatchObject({
      sendStatus: 'drafted',
      draftText:
        'Hey Candace, a stale warmer rewrite must not replace the posted bytes.',
      presentationMessageId: null,
    });
    expect(rewritten.presentation?.text).toContain(
      'stale warmer rewrite must not replace the posted bytes',
    );
    expect(sendToTarget).not.toHaveBeenCalled();
  });

  it('blocks an approved send at the final preflight when the target integration is unhealthy', async () => {
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
    updateMessageAction(action.messageActionId, {
      sendStatus: 'approved',
      approvedAt: '2026-04-08T19:41:00.000Z',
      requiresApproval: false,
      trustLevel: 'approve_before_send',
      presentationMessageId: 'bb:unhealthy-preflight-card',
      presentationThreadId: action.presentationChatJid || null,
    });
    upsertToolReliabilityRollup({
      subjectId: 'integration:bluebubbles',
      updatedAt: '2026-04-08T19:41:00.000Z',
      sampleCount: 3,
      successRate: 0,
      degradedRate: 0,
      blockedRate: 1,
      fallbackRate: 0,
      reliabilityScore: 0.05,
      currentHealth: 'blocked',
      confidenceCap: 0.2,
      cooldownUntil: null,
      nextAction: 'Complete same-thread message-action proof.',
      privacyJson: '{"metadataOnly":true}',
    });
    const sendToTarget = vi.fn(async () => ({
      platformMessageId: 'bb:should-not-send',
    }));

    const result = await applyMessageActionOperation(
      action.messageActionId,
      { kind: 'send' },
      {
        groupFolder: 'main',
        channel: 'bluebubbles',
        chatJid: 'bb:chat-1',
        currentTime: new Date('2026-04-08T19:42:00.000Z'),
        sendToTarget,
      },
    );

    expect(result.handled).toBe(true);
    expect(result.replyText).toContain('final action preflight returned defer');
    expect(sendToTarget).not.toHaveBeenCalled();
    expect(getMessageAction(action.messageActionId)?.sendStatus).toBe(
      'drafted',
    );
    expect(getCommunicationThread(thread.id)?.suggestedNextAction).toBe(
      'draft_reply',
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
    confirmMessageActionPresentation(action);

    await applyMessageActionOperation(
      action.messageActionId,
      { kind: 'defer' },
      {
        groupFolder: 'main',
        channel: 'bluebubbles',
        chatJid: 'bb:chat-1',
        currentTime: new Date('2026-04-08T19:41:00.000Z'),
        ownerAuthorizationAt: '2026-04-08T19:40:30.000Z',
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
    expect(scheduled.approvedAt).toBe('2026-04-08T19:40:30.000Z');
    expect(sendToTarget).toHaveBeenCalledWith(
      'bluebubbles',
      'bb:chat-1',
      'Yes, tonight still works for me.',
      expect.objectContaining({
        suppressSenderLabel: true,
        blueBubblesAuthorizationAt: '2026-04-08T19:40:30.000Z',
        blueBubblesPauseGeneration: 0,
      }),
    );
    expect(getMessageAction(action.messageActionId)?.sendStatus).toBe('sent');
    expect(getCommunicationThread(thread.id)?.followupState).toBe(
      'waiting_on_them',
    );
  });

  it('rejects a scheduled send when pause and resume interleave before the provider effect', async () => {
    vi.stubEnv('BLUEBUBBLES_SEND_ENABLED', 'true');
    const thread = seedCommunicationThread({
      id: 'comm-scheduled-pause-resume-race',
    });
    const action = createOrRefreshMessageActionFromDraft({
      groupFolder: 'main',
      presentationChannel: 'telegram',
      presentationChatJid: 'tg:main',
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
    confirmMessageActionPresentation(action, 'tg:scheduled-race-card');
    await applyMessageActionOperation(
      action.messageActionId,
      { kind: 'defer' },
      {
        groupFolder: 'main',
        channel: 'telegram',
        chatJid: 'tg:main',
        currentTime: new Date('2026-04-08T19:41:00.000Z'),
        ownerAuthorizationAt: '2026-04-08T19:40:30.000Z',
        sendToTarget: vi.fn(async () => ({ platformMessageId: 'unused' })),
      },
    );
    const scheduled = getMessageAction(action.messageActionId)!;
    let providerPostCount = 0;
    const sendToBoundary = vi.fn(
      async (
        _targetChannel: string,
        _chatJid: string,
        _text: string,
        options?: SendMessageOptions,
      ) => {
        setMessagingOutboundPaused({
          paused: true,
          changedByChatJid: 'tg:owner',
          reason: 'owner_stop_during_scheduled_preflight',
          now: new Date('2026-04-08T20:59:00.000Z'),
        });
        setMessagingOutboundPaused({
          paused: false,
          changedByChatJid: 'tg:owner',
          reason: 'owner_resume_during_scheduled_preflight',
          now: new Date('2026-04-08T20:59:00.001Z'),
        });
        const validation = validateMessagingOutboundAuthorizationFence({
          authorizationAt: options?.blueBubblesAuthorizationAt || '',
          pauseGeneration: options?.blueBubblesPauseGeneration ?? -1,
        });
        if (!validation.ok) {
          throw new ChannelDeliveryRejectedBeforeDispatchError(
            validation.reason || 'stale owner authorization',
          );
        }
        providerPostCount += 1;
        return { platformMessageId: 'bb:scheduled-race-must-not-post' };
      },
    );

    const runResult = await runScheduledMessageActionByTaskId(
      scheduled.scheduledTaskId!,
      {
        groupFolder: 'main',
        channel: 'telegram',
        chatJid: 'tg:main',
        currentTime: new Date('2026-04-08T21:00:00.000Z'),
        sendToTarget: sendToBoundary,
      },
    );

    expect(runResult.resultSummary).toContain('Scheduled message send failed');
    expect(sendToBoundary).toHaveBeenCalledTimes(1);
    expect(providerPostCount).toBe(0);
    expect(getMessageAction(action.messageActionId)?.sendStatus).toBe('failed');
  });

  it('invalidates a pre-pause scheduled-send authorization even after the owner resumes', async () => {
    vi.stubEnv('BLUEBUBBLES_SEND_ENABLED', 'true');
    const thread = seedCommunicationThread({
      id: 'comm-pre-pause-scheduled-send',
    });
    const action = createOrRefreshMessageActionFromDraft({
      groupFolder: 'main',
      presentationChannel: 'telegram',
      presentationChatJid: 'tg:main',
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
    confirmMessageActionPresentation(action, 'tg:scheduled-before-stop-card');

    await applyMessageActionOperation(
      action.messageActionId,
      { kind: 'defer' },
      {
        groupFolder: 'main',
        channel: 'telegram',
        chatJid: 'tg:main',
        currentTime: new Date('2026-04-08T19:41:00.000Z'),
        ownerAuthorizationAt: '2026-04-08T19:40:30.000Z',
        sendToTarget: vi.fn(async () => ({ platformMessageId: 'unused' })),
      },
    );
    const scheduled = getMessageAction(action.messageActionId)!;
    expect(scheduled.approvedAt).toBe('2026-04-08T19:40:30.000Z');

    setMessagingOutboundPaused({
      paused: true,
      changedByChatJid: 'tg:owner',
      reason: 'owner_natural_language_pause',
      now: new Date('2026-04-08T19:50:00.000Z'),
    });
    setMessagingOutboundPaused({
      paused: false,
      changedByChatJid: 'tg:owner',
      reason: 'owner_explicit_resume',
      now: new Date('2026-04-08T19:55:00.000Z'),
    });
    const sendToTarget = vi.fn(async () => ({
      platformMessageId: 'bb:must-not-send-after-resume',
    }));

    const runResult = await runScheduledMessageActionByTaskId(
      scheduled.scheduledTaskId!,
      {
        groupFolder: 'main',
        channel: 'telegram',
        chatJid: 'tg:main',
        currentTime: new Date('2026-04-08T21:00:00.000Z'),
        sendToTarget,
      },
    );

    expect(runResult.handled).toBe(true);
    expect(runResult.resultSummary).toContain('needs a fresh owner action');
    expect(sendToTarget).not.toHaveBeenCalled();
    expect(getMessageAction(action.messageActionId)).toMatchObject({
      sendStatus: 'failed',
      scheduledTaskId: null,
    });
    expect(getTaskById(scheduled.scheduledTaskId!)?.status).toBe('paused');
  });

  it('allows a newly scheduled send whose owner authorization is after the last pause', async () => {
    vi.stubEnv('BLUEBUBBLES_SEND_ENABLED', 'true');
    setMessagingOutboundPaused({
      paused: true,
      changedByChatJid: 'tg:owner',
      reason: 'owner_natural_language_pause',
      now: new Date('2026-04-08T19:30:00.000Z'),
    });
    setMessagingOutboundPaused({
      paused: false,
      changedByChatJid: 'tg:owner',
      reason: 'owner_explicit_resume',
      now: new Date('2026-04-08T19:35:00.000Z'),
    });
    const thread = seedCommunicationThread({
      id: 'comm-post-resume-scheduled-send',
    });
    const action = createOrRefreshMessageActionFromDraft({
      groupFolder: 'main',
      presentationChannel: 'telegram',
      presentationChatJid: 'tg:main',
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
    confirmMessageActionPresentation(action, 'tg:scheduled-after-stop-card');

    await applyMessageActionOperation(
      action.messageActionId,
      { kind: 'defer' },
      {
        groupFolder: 'main',
        channel: 'telegram',
        chatJid: 'tg:main',
        currentTime: new Date('2026-04-08T19:41:00.000Z'),
        ownerAuthorizationAt: '2026-04-08T19:40:30.000Z',
        sendToTarget: vi.fn(async () => ({ platformMessageId: 'unused' })),
      },
    );
    const scheduled = getMessageAction(action.messageActionId)!;
    const sendToTarget = vi.fn(async () => ({
      platformMessageId: 'bb:fresh-post-resume-send',
    }));

    await runScheduledMessageActionByTaskId(scheduled.scheduledTaskId!, {
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:main',
      currentTime: new Date('2026-04-08T21:00:00.000Z'),
      sendToTarget,
    });

    expect(scheduled.approvedAt).toBe('2026-04-08T19:40:30.000Z');
    expect(sendToTarget).toHaveBeenCalledTimes(1);
    expect(getMessageAction(action.messageActionId)?.sendStatus).toBe('sent');
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

    expect(
      resolveMessageActionForFollowup({
        groupFolder: 'main',
        chatJid: 'tg:main',
        rawText: 'send this to Candace',
        now: new Date('2026-04-08T19:46:00.000Z'),
      }),
    ).toBeUndefined();
    updateMessageAction(action.messageActionId, {
      presentationMessageId: 'tg:candace-reviewed-card',
    });

    const resolved = resolveMessageActionForFollowup({
      groupFolder: 'main',
      chatJid: 'tg:main',
      rawText: 'send this to Candace',
      now: new Date('2026-04-08T19:46:00.000Z'),
    });

    expect(resolved?.messageActionId).toBe(action.messageActionId);
  });

  it('binds a callback to the exact presentation card and thread', () => {
    const action = {
      presentationMessageId: 'tg:card-1',
      presentationThreadId: 'topic-7',
    };

    expect(
      isMessageActionBoundToPresentationMessage({
        action,
        presentationMessageId: 'tg:card-1',
        presentationThreadId: 'topic-7',
      }),
    ).toBe(true);
    expect(
      isMessageActionBoundToPresentationMessage({
        action,
        presentationMessageId: 'tg:other-card',
        presentationThreadId: 'topic-7',
      }),
    ).toBe(false);
    expect(
      isMessageActionBoundToPresentationMessage({
        action,
        presentationMessageId: 'tg:card-1',
        presentationThreadId: 'topic-8',
      }),
    ).toBe(false);
  });

  it('creates a new immutable card action when the recipient changes', () => {
    const candaceThread = seedCommunicationThread({
      id: 'comm-card-target-change',
      title: 'Candace',
      channelChatJid: 'bb:card-candace',
      lastMessageId: 'bb:card-candace-last',
    });
    const original = createOrRefreshMessageActionFromDraft({
      groupFolder: 'main',
      presentationChannel: 'telegram',
      presentationChatJid: 'tg:main',
      sourceType: 'communication_thread',
      sourceKey: candaceThread.id,
      sourceSummary: 'A draft first shown for Candace.',
      draftText: 'Yes, that works.',
      personName: 'Candace',
      threadTitle: 'Candace',
      communicationThreadId: candaceThread.id,
      now: new Date('2026-04-08T19:45:00.000Z'),
    });
    updateMessageAction(original.messageActionId, {
      presentationMessageId: 'tg:old-candace-card',
    });

    const refreshed = createOrRefreshMessageActionFromDraft({
      groupFolder: 'main',
      presentationChannel: 'telegram',
      presentationChatJid: 'tg:main',
      sourceType: 'communication_thread',
      sourceKey: candaceThread.id,
      sourceSummary: 'The source was rebound to Travis.',
      draftText: 'Yes, that works.',
      personName: 'Travis',
      threadTitle: 'Travis',
      communicationThreadId: candaceThread.id,
      targetOverride: {
        kind: 'external_thread',
        chatJid: 'bb:card-avery',
        personName: 'Travis',
      },
      now: new Date('2026-04-08T19:46:00.000Z'),
    });

    expect(refreshed.messageActionId).not.toBe(original.messageActionId);
    expect(refreshed.presentationMessageId).toBeNull();
    expect(getMessageAction(original.messageActionId)?.sendStatus).toBe(
      'skipped',
    );
    expect(
      getMessageAction(original.messageActionId)?.presentationMessageId,
    ).toBe('tg:old-candace-card');
  });

  it.each([
    {
      label: 'letter case',
      originalBody: 'Dinner is ready.',
      revisedBody: 'dinner is ready.',
    },
    {
      label: 'interior whitespace',
      originalBody: 'Dinner  is ready.',
      revisedBody: 'Dinner is ready.',
    },
  ])(
    'creates a new immutable card when only $label changes in the body',
    ({ originalBody, revisedBody }) => {
      const thread = seedCommunicationThread({
        id: 'comm-card-body-change',
        title: 'Candace',
        channelChatJid: 'bb:card-body-change',
      });
      const original = createOrRefreshMessageActionFromDraft({
        groupFolder: 'main',
        presentationChannel: 'telegram',
        presentationChatJid: 'tg:main',
        sourceType: 'communication_thread',
        sourceKey: thread.id,
        sourceSummary: 'Original exact-body draft.',
        draftText: originalBody,
        personName: 'Candace',
        threadTitle: 'Candace',
        communicationThreadId: thread.id,
        now: new Date('2026-04-08T19:45:00.000Z'),
      });
      updateMessageAction(original.messageActionId, {
        presentationMessageId: 'tg:original-body-card',
      });

      const revised = createOrRefreshMessageActionFromDraft({
        groupFolder: 'main',
        presentationChannel: 'telegram',
        presentationChatJid: 'tg:main',
        sourceType: 'communication_thread',
        sourceKey: thread.id,
        sourceSummary: 'Revised exact-body draft.',
        draftText: revisedBody,
        personName: 'Candace',
        threadTitle: 'Candace',
        communicationThreadId: thread.id,
        now: new Date('2026-04-08T19:46:00.000Z'),
      });

      expect(revised.messageActionId).not.toBe(original.messageActionId);
      expect(revised.presentationMessageId).toBeNull();
      expect(getMessageAction(original.messageActionId)?.sendStatus).toBe(
        'skipped',
      );
      expect(
        getMessageAction(original.messageActionId)?.presentationMessageId,
      ).toBe('tg:original-body-card');
    },
  );

  it('allows only CRLF-to-LF normalization when reusing an action card', () => {
    const thread = seedCommunicationThread({
      id: 'comm-card-line-endings',
      title: 'Candace',
      channelChatJid: 'bb:card-line-endings',
    });
    const original = createOrRefreshMessageActionFromDraft({
      groupFolder: 'main',
      presentationChannel: 'telegram',
      presentationChatJid: 'tg:main',
      sourceType: 'communication_thread',
      sourceKey: thread.id,
      sourceSummary: 'CRLF draft.',
      draftText: 'First line.\r\nSecond line.',
      personName: 'Candace',
      threadTitle: 'Candace',
      communicationThreadId: thread.id,
      now: new Date('2026-04-08T19:45:00.000Z'),
    });
    updateMessageAction(original.messageActionId, {
      presentationMessageId: 'tg:line-ending-card',
    });

    const refreshed = createOrRefreshMessageActionFromDraft({
      groupFolder: 'main',
      presentationChannel: 'telegram',
      presentationChatJid: 'tg:main',
      sourceType: 'communication_thread',
      sourceKey: thread.id,
      sourceSummary: 'LF draft.',
      draftText: 'First line.\nSecond line.',
      personName: 'Candace',
      threadTitle: 'Candace',
      communicationThreadId: thread.id,
      now: new Date('2026-04-08T19:46:00.000Z'),
    });

    expect(refreshed.messageActionId).toBe(original.messageActionId);
    expect(refreshed.presentationMessageId).toBe('tg:line-ending-card');
  });

  it('fails closed when an explicit person does not match the open draft', () => {
    const averyThread = seedCommunicationThread({
      id: 'comm-avery-only',
      title: 'Travis',
      channelChatJid: 'bb:avery-only',
      lastMessageId: 'bb:avery-last',
    });
    createOrRefreshMessageActionFromDraft({
      groupFolder: 'main',
      presentationChannel: 'telegram',
      presentationChatJid: 'tg:main',
      sourceType: 'communication_thread',
      sourceKey: averyThread.id,
      sourceSummary: 'Travis has the latest draft.',
      draftText: 'Dinner is ready.',
      personName: 'Travis',
      threadTitle: 'Travis',
      communicationThreadId: averyThread.id,
      communicationContext: 'reply_followthrough',
      now: new Date('2026-04-08T19:45:00.000Z'),
    });

    expect(
      resolveMessageActionForFollowup({
        groupFolder: 'main',
        chatJid: 'tg:main',
        rawText: 'send this to Candace',
        now: new Date('2026-04-08T19:46:00.000Z'),
      }),
    ).toBeUndefined();
  });

  it('does not match a requested name inside another recipient name', () => {
    const joanneThread = seedCommunicationThread({
      id: 'comm-joanne',
      title: 'Joanne',
      channelChatJid: 'bb:joanne',
      lastMessageId: 'bb:joanne-last',
    });
    createOrRefreshMessageActionFromDraft({
      groupFolder: 'main',
      presentationChannel: 'telegram',
      presentationChatJid: 'tg:main',
      sourceType: 'communication_thread',
      sourceKey: joanneThread.id,
      sourceSummary: 'Joanne has a draft.',
      draftText: 'I can make that work.',
      personName: 'Joanne',
      threadTitle: 'Joanne',
      communicationThreadId: joanneThread.id,
      communicationContext: 'reply_followthrough',
      now: new Date('2026-04-08T19:45:00.000Z'),
    });

    expect(
      resolveMessageActionForFollowup({
        groupFolder: 'main',
        chatJid: 'tg:main',
        rawText: 'send this to Ann',
        now: new Date('2026-04-08T19:46:00.000Z'),
      }),
    ).toBeUndefined();
  });

  it('matches only the full normalized structured target label', () => {
    const maryAnnThread = seedCommunicationThread({
      id: 'comm-mary-ann',
      title: 'Mary Ann',
      channelChatJid: 'bb:mary-ann',
      lastMessageId: 'bb:mary-ann-last',
    });
    const action = createOrRefreshMessageActionFromDraft({
      groupFolder: 'main',
      presentationChannel: 'telegram',
      presentationChatJid: 'tg:main',
      sourceType: 'communication_thread',
      sourceKey: maryAnnThread.id,
      sourceSummary: 'Mary Ann has a draft.',
      draftText: 'I can make that work.',
      personName: 'Mary Ann',
      threadTitle: 'Mary Ann',
      communicationThreadId: maryAnnThread.id,
      communicationContext: 'reply_followthrough',
      now: new Date('2026-04-08T19:45:00.000Z'),
    });

    expect(
      resolveMessageActionForFollowup({
        groupFolder: 'main',
        chatJid: 'tg:main',
        rawText: 'send this to Ann',
        now: new Date('2026-04-08T19:46:00.000Z'),
      }),
    ).toBeUndefined();
    updateMessageAction(action.messageActionId, {
      presentationMessageId: 'tg:mary-ann-reviewed-card',
    });
    expect(
      resolveMessageActionForFollowup({
        groupFolder: 'main',
        chatJid: 'tg:main',
        rawText: 'send this to Mary Ann',
        now: new Date('2026-04-08T19:46:00.000Z'),
      })?.messageActionId,
    ).toBe(action.messageActionId);
  });

  it('binds a Telegram reply to the exact older draft card', () => {
    const candaceThread = seedCommunicationThread({
      id: 'comm-reply-candace',
      title: 'Candace',
      channelChatJid: 'bb:reply-candace',
      lastMessageId: 'bb:reply-candace-last',
    });
    const candaceAction = createOrRefreshMessageActionFromDraft({
      groupFolder: 'main',
      presentationChannel: 'telegram',
      presentationChatJid: 'tg:main',
      sourceType: 'communication_thread',
      sourceKey: candaceThread.id,
      sourceSummary: 'Candace needs an answer.',
      draftText: 'Yes, please pick them up.',
      personName: 'Candace',
      threadTitle: 'Candace',
      communicationThreadId: candaceThread.id,
      communicationContext: 'reply_followthrough',
      now: new Date('2026-04-08T19:45:00.000Z'),
    });
    updateMessageAction(candaceAction.messageActionId, {
      presentationMessageId: 'tg:candace-card',
    });
    const averyThread = seedCommunicationThread({
      id: 'comm-reply-avery',
      title: 'Travis',
      channelChatJid: 'bb:reply-avery',
      lastMessageId: 'bb:reply-avery-last',
    });
    const averyAction = createOrRefreshMessageActionFromDraft({
      groupFolder: 'main',
      presentationChannel: 'telegram',
      presentationChatJid: 'tg:main',
      sourceType: 'communication_thread',
      sourceKey: averyThread.id,
      sourceSummary: 'Travis has the newer draft.',
      draftText: 'Dinner is ready.',
      personName: 'Travis',
      threadTitle: 'Travis',
      communicationThreadId: averyThread.id,
      communicationContext: 'reply_followthrough',
      now: new Date('2026-04-08T19:46:00.000Z'),
    });
    updateMessageAction(averyAction.messageActionId, {
      presentationMessageId: 'tg:avery-card',
    });

    const resolved = resolveMessageActionForFollowup({
      groupFolder: 'main',
      chatJid: 'tg:main',
      rawText: 'send it',
      replyToMessageId: 'tg:candace-card',
      now: new Date('2026-04-08T19:47:00.000Z'),
    });

    expect(resolved?.messageActionId).toBe(candaceAction.messageActionId);
  });

  it('does not guess when a bare Telegram followup has multiple recipients', () => {
    const firstThread = seedCommunicationThread({
      id: 'comm-ambiguous-one',
      title: 'Candace',
      channelChatJid: 'bb:ambiguous-one',
      lastMessageId: 'bb:ambiguous-one-last',
    });
    createOrRefreshMessageActionFromDraft({
      groupFolder: 'main',
      presentationChannel: 'telegram',
      presentationChatJid: 'tg:main',
      sourceType: 'communication_thread',
      sourceKey: firstThread.id,
      sourceSummary: 'Candace draft.',
      draftText: 'Yes, please.',
      personName: 'Candace',
      communicationThreadId: firstThread.id,
      now: new Date('2026-04-08T19:45:00.000Z'),
    });
    const secondThread = seedCommunicationThread({
      id: 'comm-ambiguous-two',
      title: 'Travis',
      channelChatJid: 'bb:ambiguous-two',
      lastMessageId: 'bb:ambiguous-two-last',
    });
    createOrRefreshMessageActionFromDraft({
      groupFolder: 'main',
      presentationChannel: 'telegram',
      presentationChatJid: 'tg:main',
      sourceType: 'communication_thread',
      sourceKey: secondThread.id,
      sourceSummary: 'Travis draft.',
      draftText: 'Dinner is ready.',
      personName: 'Travis',
      communicationThreadId: secondThread.id,
      now: new Date('2026-04-08T19:46:00.000Z'),
    });

    expect(
      resolveMessageActionForFollowup({
        groupFolder: 'main',
        chatJid: 'tg:main',
        rawText: 'send it',
        now: new Date('2026-04-08T19:47:00.000Z'),
      }),
    ).toBeUndefined();
  });

  it('does not guess among multiple fresh drafts for the same recipient', () => {
    const targetOverride = {
      kind: 'external_thread' as const,
      chatJid: 'bb:same-candace',
      personName: 'Candace',
    };
    createOrRefreshMessageActionFromDraft({
      groupFolder: 'main',
      presentationChannel: 'telegram',
      presentationChatJid: 'tg:main',
      sourceType: 'manual_prompt',
      sourceKey: 'same-recipient-first',
      sourceSummary: 'First Candace draft.',
      draftText: 'The first version.',
      personName: 'Candace',
      threadTitle: 'Candace',
      targetOverride,
      targetChannelOverride: 'bluebubbles',
      now: new Date('2026-04-08T19:45:00.000Z'),
    });
    createOrRefreshMessageActionFromDraft({
      groupFolder: 'main',
      presentationChannel: 'telegram',
      presentationChatJid: 'tg:main',
      sourceType: 'manual_prompt',
      sourceKey: 'same-recipient-second',
      sourceSummary: 'Second Candace draft.',
      draftText: 'The second version.',
      personName: 'Candace',
      threadTitle: 'Candace',
      targetOverride,
      targetChannelOverride: 'bluebubbles',
      now: new Date('2026-04-08T19:46:00.000Z'),
    });

    for (const rawText of [
      'send it',
      'make it shorter',
      'send this to Candace',
      'send the shorter version to Candace',
    ]) {
      expect(
        resolveMessageActionForFollowup({
          groupFolder: 'main',
          chatJid: 'tg:main',
          rawText,
          now: new Date('2026-04-08T19:47:00.000Z'),
        }),
        rawText,
      ).toBeUndefined();
    }
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

  it('does not bind a named followup to a stale open message action', () => {
    createOrRefreshMessageActionFromDraft({
      groupFolder: 'main',
      presentationChannel: 'telegram',
      presentationChatJid: 'tg:main',
      sourceType: 'communication_thread',
      sourceKey: 'comm-stale-named',
      sourceSummary: 'Older Candace draft.',
      draftText: 'Yes, tonight still works for me.',
      personName: 'Candace',
      threadTitle: 'Candace',
      communicationThreadId: 'comm-stale-named',
      communicationContext: 'reply_followthrough',
      now: new Date('2026-04-08T19:00:00.000Z'),
    });

    expect(
      resolveMessageActionForFollowup({
        groupFolder: 'main',
        chatJid: 'tg:main',
        rawText: 'send this to Candace',
        now: new Date('2026-04-08T20:00:01.000Z'),
      }),
    ).toBeUndefined();
  });

  it('treats BlueBubbles send-using phrasing as a send follow-up', () => {
    expect(interpretMessageActionFollowup('send using blue bubbles')).toEqual({
      kind: 'send',
    });
    expect(isBlueBubblesExplicitSendAlias('send that using blue bubbles')).toBe(
      true,
    );
  });

  it('accepts @Andrea-prefixed BlueBubbles action follow-ups', () => {
    expect(
      interpretMessageActionFollowup('@Andrea send it later tonight'),
    ).toEqual({
      kind: 'defer',
      timingHint: 'today tonight',
    });
    expect(
      interpretMessageActionFollowup('@Andrea, send it later tonight'),
    ).toEqual({
      kind: 'defer',
      timingHint: 'today tonight',
    });
    expect(
      isBlueBubblesExplicitSendAlias('@Andrea send that using blue bubbles'),
    ).toBe(true);
    expect(interpretMessageActionFollowup('send it later tonight.')).toEqual({
      kind: 'defer',
      timingHint: 'today tonight',
    });
    expect(interpretMessageActionFollowup('show it again!')).toEqual({
      kind: 'show_draft',
    });
    expect(interpretMessageActionFollowup('not now?')).toEqual({
      kind: 'skip',
    });
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
      presentationChatJid: 'bb:iMessage;-;+12025550199',
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
      chatJid: 'bb:iMessage;-;+12025550199',
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

  it('parses provider-first wording without treating a funny directive as literal content', () => {
    expect(
      parseExplicitBlueBubblesThreadSendIntent(
        'Have BlueBubbles send Avery Example a message saying The package arrived, and make it funny.',
      ),
    ).toEqual({
      targetLabel: 'Avery Example',
      draftText: 'The package arrived',
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
      'bb:iMessage;-;+12025550177',
      '2026-04-10T19:01:34.886Z',
      'Jeff',
      'bluebubbles',
      false,
    );

    const resolved = resolveBlueBubblesThreadTargetByName('Rad Dad');
    expect(resolved.state).toBe('resolved');
    if (resolved.state !== 'resolved') {
      throw new Error('expected resolved target');
    }
    expect(resolved.target.chatJid).toBe('bb:iMessage;+;chat-rad-dad');
    expect(resolved.target.displayName).toBe('Rad Dad');
    expect(resolved.target.isGroup).toBe(true);
  });

  it('resolves an exact direct-chat phone or email address without guessing a name', () => {
    storeChatMetadata(
      'bb:iMessage;-;+12025550177',
      '2026-04-10T19:01:34.886Z',
      undefined,
      'bluebubbles',
      false,
    );

    const resolved = resolveBlueBubblesThreadTargetByName('+1 202 555 0177');
    expect(resolved).toMatchObject({
      state: 'resolved',
      target: {
        chatJid: 'bb:iMessage;-;+12025550177',
        isGroup: false,
      },
    });
  });

  it('requires clarification for a partial stored-chat name instead of guessing', () => {
    storeChatMetadata(
      'bb:iMessage;-;+12025550177',
      '2026-04-10T19:01:34.886Z',
      'Avery Example',
      'bluebubbles',
      false,
    );

    expect(resolveBlueBubblesThreadTargetByName('Avery')).toMatchObject({
      state: 'ambiguous',
      matches: [{ displayName: 'Avery Example' }],
    });
  });

  it('treats a group GUID as a group even when persisted metadata is stale', () => {
    storeChatMetadata(
      'bb:iMessage;+;family-group-guid',
      '2026-04-10T19:01:34.886Z',
      'Family Group',
      'bluebubbles',
      false,
    );

    expect(resolveBlueBubblesThreadTargetByName('Family Group')).toMatchObject({
      state: 'resolved',
      target: { isGroup: true },
    });
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
      presentationChatJid: 'bb:iMessage;-;+12025550199',
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
