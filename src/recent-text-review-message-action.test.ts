import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _closeDatabase,
  _initTestDatabase,
  getCommunicationThread,
  getMessageAction,
  listCommunicationSignalsForThread,
  storeChatMetadata,
  storeMessageDirect,
  updateMessageAction,
} from './db.js';
import {
  applyMessageActionOperation,
  type MessageActionExecutionDeps,
} from './message-actions.js';
import { stageBlueBubblesOutboundRequest } from './bluebubbles-outbound-request.js';
import {
  buildRecentTextReviewSeedJson,
  reviewRecentTexts,
} from './recent-text-review.js';
import type { AssistantCapabilityConversationSeed } from './assistant-capabilities.js';
import {
  _getSharedAssistantCapabilitySeedForTests,
  _setBlueBubblesConversationBindingForTests,
  _setRegisteredGroups,
  _setSharedAssistantCapabilitySeedForTests,
  buildRecentTextReviewMessageActionLink,
  completeRecentTextReviewMessageActionLifecycle,
} from './index.js';
import type { MessageActionRecord, RegisteredGroup } from './types.js';

const OWNER_CHAT_JID = 'tg:owner';
const SELF_CHAT_JID = 'bb:iMessage;-;+12025550199';
const TARGET_CHAT_JID = 'bb:iMessage;-;+12025550123';
const REVIEWED_AT = new Date('2026-07-16T17:00:00.000Z');
const SENT_AT = new Date('2026-07-16T17:05:00.000Z');

const ownerGroup: RegisteredGroup = {
  name: 'Owner',
  folder: 'main',
  trigger: '@andrea',
  added_at: REVIEWED_AT.toISOString(),
  isMain: true,
  requiresTrigger: false,
};

async function stageReviewBoundDraft(): Promise<{
  action: MessageActionRecord;
  communicationThreadId: string;
  seed: AssistantCapabilityConversationSeed;
}> {
  storeChatMetadata(
    TARGET_CHAT_JID,
    '2026-07-16T16:00:00.000Z',
    'Avery Example',
    'bluebubbles',
    false,
  );
  storeMessageDirect({
    id: 'bb:review-inbound-1',
    chat_jid: TARGET_CHAT_JID,
    sender: 'bb:+12025550123',
    sender_name: 'Avery Example',
    content: 'Does dinner still work tonight?',
    timestamp: '2026-07-16T16:00:00.000Z',
    is_from_me: false,
    is_bot_message: false,
    message_ingress_origin: 'passive_contact_sync',
  });
  const review = await reviewRecentTexts({
    groupFolder: 'main',
    channel: 'telegram',
    now: REVIEWED_AT,
    timeWindowKind: 'today',
    cloudAnalysisMode: 'disabled',
  });
  const item = review.needsReply[0];
  if (!item?.communicationThreadId) {
    throw new Error('expected a review item with a durable thread binding');
  }
  const seedJson = buildRecentTextReviewSeedJson(review);
  const seed: AssistantCapabilityConversationSeed = {
    flowKey: 'communication_review_recent_texts',
    subjectKind: 'communication_thread',
    summaryText: review.summaryText,
    guidanceGoal: 'open_conversation',
    subjectData: {
      activeCapabilityId: 'communication.review_recent_texts',
      recentTextReviewJson: seedJson,
    },
  };
  _setSharedAssistantCapabilitySeedForTests(OWNER_CHAT_JID, seed, REVIEWED_AT);
  const recentTextReview = buildRecentTextReviewMessageActionLink({
    groupFolder: 'main',
    presentationChatJid: OWNER_CHAT_JID,
    targetChatJid: TARGET_CHAT_JID,
    seedJson,
    item,
  });
  if (!recentTextReview) {
    throw new Error('expected immutable review linkage');
  }
  const staged = stageBlueBubblesOutboundRequest({
    groupFolder: 'main',
    channel: 'telegram',
    chatJid: OWNER_CHAT_JID,
    group: ownerGroup,
    ownerAuthored: true,
    rawText: 'Text Avery Example: Yes, dinner still works tonight.',
    inboundMessageId: 'tg:review-send-1',
    recipientResolution: {
      state: 'resolved',
      target: {
        chatJid: TARGET_CHAT_JID,
        displayName: 'Avery Example',
        isGroup: false,
      },
    },
    recentTextReview,
    now: REVIEWED_AT,
  });
  if (!staged.handled || staged.state !== 'staged') {
    throw new Error('expected a staged review-bound draft');
  }
  return {
    action: staged.action,
    communicationThreadId: item.communicationThreadId,
    seed,
  };
}

describe('recent-review message-action lifecycle', () => {
  beforeEach(() => {
    _initTestDatabase();
    vi.stubEnv('ANDREA_TEST_DISABLE_OWNER_ENV_FILE', '1');
    vi.stubEnv('BLUEBUBBLES_CANONICAL_SELF_THREAD_JID', SELF_CHAT_JID);
    vi.stubEnv('BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS', SELF_CHAT_JID);
    _setRegisteredGroups({ [OWNER_CHAT_JID]: ownerGroup });
    _setBlueBubblesConversationBindingForTests({
      enabled: true,
      groupFolder: 'main',
    });
  });

  afterEach(() => {
    _setRegisteredGroups({});
    _setBlueBubblesConversationBindingForTests(undefined);
    _closeDatabase();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('retires the exact numbered seed and marks the review handled after a separate verified approval, idempotently', async () => {
    const { action, communicationThreadId } = await stageReviewBoundDraft();
    const refs = JSON.parse(action.linkedRefsJson || '{}') as Record<
      string,
      unknown
    >;
    expect(refs.recentTextReview).toMatchObject({
      version: 2,
      communicationThreadId,
    });
    expect(JSON.stringify(refs.recentTextReview)).not.toContain(
      'Does dinner still work tonight?',
    );
    expect(JSON.stringify(refs.recentTextReview)).not.toContain(
      TARGET_CHAT_JID,
    );

    const sendToTarget = vi.fn(async () => ({
      platformMessageId: 'bb:verified-review-reply',
      threadId: TARGET_CHAT_JID,
    }));
    const deps: MessageActionExecutionDeps = {
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: OWNER_CHAT_JID,
      currentTime: SENT_AT,
      ownerAuthorizationAt: SENT_AT.toISOString(),
      primeMessagesChatHistory: async (chatJid) => ({
        chatJid,
        storedCount: 1,
        totalCount: 1,
      }),
      sendToTarget,
      onVerifiedSend: (verifiedAction) => {
        completeRecentTextReviewMessageActionLifecycle({
          action: verifiedAction,
          now: SENT_AT,
        });
      },
    };

    const withoutPresentation = await applyMessageActionOperation(
      action.messageActionId,
      { kind: 'send' },
      deps,
    );
    expect(withoutPresentation.action?.sendStatus).toBe('drafted');
    expect(sendToTarget).not.toHaveBeenCalled();
    expect(
      _getSharedAssistantCapabilitySeedForTests(OWNER_CHAT_JID, SENT_AT),
    ).not.toBeNull();

    updateMessageAction(action.messageActionId, {
      presentationMessageId: 'tg:review-card-1',
      lastUpdatedAt: SENT_AT.toISOString(),
    });
    const approved = await applyMessageActionOperation(
      action.messageActionId,
      { kind: 'send' },
      deps,
    );
    expect(approved.action?.sendStatus).toBe('sent');
    expect(sendToTarget).toHaveBeenCalledTimes(1);
    expect(getCommunicationThread(communicationThreadId)).toMatchObject({
      followupState: 'resolved',
      urgency: 'none',
      suggestedNextAction: 'ignore',
    });
    expect(
      listCommunicationSignalsForThread(communicationThreadId).filter(
        (signal) => signal.summaryText.includes('Recent text review handled'),
      ),
    ).toHaveLength(1);
    expect(
      _getSharedAssistantCapabilitySeedForTests(OWNER_CHAT_JID, SENT_AT),
    ).toBeNull();
    expect(
      _getSharedAssistantCapabilitySeedForTests(SELF_CHAT_JID, SENT_AT),
    ).toBeNull();

    const replay = await applyMessageActionOperation(
      action.messageActionId,
      { kind: 'send' },
      { ...deps, currentTime: new Date('2026-07-16T17:06:00.000Z') },
    );
    expect(replay.action?.sendStatus).toBe('sent');
    expect(sendToTarget).toHaveBeenCalledTimes(1);
    expect(
      listCommunicationSignalsForThread(communicationThreadId).filter(
        (signal) => signal.summaryText.includes('Recent text review handled'),
      ),
    ).toHaveLength(1);
  });

  it('leaves review state untouched when persisted linkage is malformed', async () => {
    const { action, communicationThreadId, seed } =
      await stageReviewBoundDraft();
    const refs = JSON.parse(action.linkedRefsJson || '{}') as {
      recentTextReview?: { linkFingerprint?: string };
    };
    if (!refs.recentTextReview) throw new Error('expected review linkage');
    refs.recentTextReview.linkFingerprint = '0'.repeat(64);
    updateMessageAction(action.messageActionId, {
      linkedRefsJson: JSON.stringify(refs),
      presentationMessageId: 'tg:review-card-corrupt',
      lastUpdatedAt: SENT_AT.toISOString(),
    });
    const sendToTarget = vi.fn(async () => ({
      platformMessageId: 'bb:verified-corrupt-link-reply',
      threadId: TARGET_CHAT_JID,
    }));
    const approved = await applyMessageActionOperation(
      action.messageActionId,
      { kind: 'send' },
      {
        groupFolder: 'main',
        channel: 'telegram',
        chatJid: OWNER_CHAT_JID,
        currentTime: SENT_AT,
        ownerAuthorizationAt: SENT_AT.toISOString(),
        primeMessagesChatHistory: async (chatJid) => ({
          chatJid,
          storedCount: 1,
          totalCount: 1,
        }),
        sendToTarget,
        onVerifiedSend: (verifiedAction) => {
          completeRecentTextReviewMessageActionLifecycle({
            action: verifiedAction,
            now: SENT_AT,
          });
        },
      },
    );
    expect(approved.action?.sendStatus).toBe('skipped');
    expect(approved.replyText).toContain('missing or corrupt');
    expect(sendToTarget).not.toHaveBeenCalled();
    expect(getMessageAction(action.messageActionId)?.sendStatus).toBe(
      'skipped',
    );
    expect(
      listCommunicationSignalsForThread(communicationThreadId).filter(
        (signal) => signal.summaryText.includes('Recent text review handled'),
      ),
    ).toHaveLength(0);
    expect(
      _getSharedAssistantCapabilitySeedForTests(OWNER_CHAT_JID, SENT_AT),
    ).toEqual(seed);
  });

  it('blocks a review-derived send when the exact link is missing', async () => {
    const { action } = await stageReviewBoundDraft();
    const refs = JSON.parse(action.linkedRefsJson || '{}') as Record<
      string,
      unknown
    >;
    delete refs.recentTextReview;
    updateMessageAction(action.messageActionId, {
      linkedRefsJson: JSON.stringify(refs),
      presentationMessageId: 'tg:review-card-missing-link',
      lastUpdatedAt: SENT_AT.toISOString(),
    });
    const sendToTarget = vi.fn(async () => ({
      platformMessageId: 'bb:must-not-send-missing-link',
      threadId: TARGET_CHAT_JID,
    }));

    const blocked = await applyMessageActionOperation(
      action.messageActionId,
      { kind: 'send' },
      {
        groupFolder: 'main',
        channel: 'telegram',
        chatJid: OWNER_CHAT_JID,
        currentTime: SENT_AT,
        ownerAuthorizationAt: SENT_AT.toISOString(),
        primeMessagesChatHistory: async (chatJid) => ({
          chatJid,
          storedCount: 1,
          totalCount: 1,
        }),
        sendToTarget,
      },
    );

    expect(blocked.action?.sendStatus).toBe('skipped');
    expect(blocked.replyText).toContain('missing or corrupt');
    expect(sendToTarget).not.toHaveBeenCalled();
  });

  it('blocks a staged review reply after the recipient materially changes the thread', async () => {
    const { action } = await stageReviewBoundDraft();
    updateMessageAction(action.messageActionId, {
      presentationMessageId: 'tg:review-card-stale-thread',
      lastUpdatedAt: SENT_AT.toISOString(),
    });
    storeMessageDirect({
      id: 'bb:review-never-mind-after-staging',
      chat_jid: TARGET_CHAT_JID,
      sender: 'bb:+12025550123',
      sender_name: 'Avery Example',
      content: 'Never mind, dinner is handled.',
      timestamp: '2026-07-16T17:04:00.000Z',
      is_from_me: false,
      is_bot_message: false,
      message_ingress_origin: 'passive_contact_sync',
    });
    const sendToTarget = vi.fn(async () => ({
      platformMessageId: 'bb:must-not-send-stale-review',
      threadId: TARGET_CHAT_JID,
    }));

    const blocked = await applyMessageActionOperation(
      action.messageActionId,
      { kind: 'send' },
      {
        groupFolder: 'main',
        channel: 'telegram',
        chatJid: OWNER_CHAT_JID,
        currentTime: SENT_AT,
        ownerAuthorizationAt: SENT_AT.toISOString(),
        primeMessagesChatHistory: async (chatJid) => ({
          chatJid,
          storedCount: 1,
          totalCount: 1,
        }),
        sendToTarget,
      },
    );

    expect(blocked.action?.sendStatus).toBe('skipped');
    expect(blocked.replyText).toContain('newer activity');
    expect(sendToTarget).not.toHaveBeenCalled();
  });
});
