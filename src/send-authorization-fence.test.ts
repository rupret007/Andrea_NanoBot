import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  executeBlueBubblesOutboundRequest,
  stageBlueBubblesOutboundRequest,
} from './bluebubbles-outbound-request.js';
import { executeBlueBubblesOutboundTurn } from './bluebubbles-outbound-turn.js';
import { resolveBlueBubblesSendMethod } from './channels/bluebubbles.js';
import {
  _closeDatabase,
  _initTestDatabase,
  getChatName,
  getMessageAction,
  listMessageActionsForGroup,
  setRegisteredGroup,
  storeChatMetadata,
  updateMessageAction,
  upsertCommunicationThread,
} from './db.js';
import {
  applyMessageActionOperation,
  createOrRefreshMessageActionFromDraft,
  interpretMessageActionFollowup,
  runScheduledMessageActionByTaskId,
} from './message-actions.js';
import { runtimeCapabilityRegistry } from './runtime-capability-registry.js';
import { registerProductionRuntimeCapabilitySurfaces } from './runtime-capability-production-surfaces.js';
import {
  isAuthorizedBlueBubblesSendCallerJid,
  isAuthorizedTelegramSendCallerJid,
  isNeverAuthorizeSendCaller,
  isNeverAuthorizeSendSurface,
  isRegisteredTelegramFrontDoorJid,
  isTrustedOwnerReviewSurface,
  resolveRegisteredTelegramFrontDoorJid,
} from './trusted-owner-review-surface.js';
import type { RegisteredGroup } from './types.js';

import './channels/index.js';

registerProductionRuntimeCapabilitySurfaces(runtimeCapabilityRegistry);

const mainGroup: RegisteredGroup = {
  name: 'Main',
  folder: 'main',
  trigger: '@Andrea',
  added_at: '2026-08-23T00:00:00.000Z',
  requiresTrigger: false,
  isMain: true,
};

function seedRecipient() {
  storeChatMetadata(
    'bb:iMessage;-;+12025550123',
    '2026-08-23T00:00:00.000Z',
    'Avery Example',
    'bluebubbles',
    false,
  );
}

function registerBobFrontDoor() {
  setRegisteredGroup('tg:main', mainGroup);
}

describe('send authorization fence', () => {
  const originalDisable = process.env.ANDREA_TEST_DISABLE_OWNER_ENV_FILE;
  const originalCanonical = process.env.BLUEBUBBLES_CANONICAL_SELF_THREAD_JID;

  beforeEach(() => {
    _initTestDatabase();
    process.env.ANDREA_TEST_DISABLE_OWNER_ENV_FILE = '1';
    process.env.BLUEBUBBLES_CANONICAL_SELF_THREAD_JID =
      'iMessage;-;owner@example.invalid';
  });

  afterEach(() => {
    _closeDatabase();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (originalDisable == null) {
      delete process.env.ANDREA_TEST_DISABLE_OWNER_ENV_FILE;
    } else {
      process.env.ANDREA_TEST_DISABLE_OWNER_ENV_FILE = originalDisable;
    }
    if (originalCanonical == null) {
      delete process.env.BLUEBUBBLES_CANONICAL_SELF_THREAD_JID;
    } else {
      process.env.BLUEBUBBLES_CANONICAL_SELF_THREAD_JID = originalCanonical;
    }
  });

  it('keeps AppleScript as the only outbound send method', () => {
    expect(resolveBlueBubblesSendMethod()).toBe('apple-script');
    expect(resolveBlueBubblesSendMethod(null)).toBe('apple-script');
    expect(resolveBlueBubblesSendMethod('private-api')).toBe('apple-script');
    expect(resolveBlueBubblesSendMethod('private_api')).toBe('apple-script');
    expect(resolveBlueBubblesSendMethod('PRIVATE-API')).toBe('apple-script');
    expect(resolveBlueBubblesSendMethod('  private-api  ')).toBe(
      'apple-script',
    );
    expect(resolveBlueBubblesSendMethod('apple-script')).toBe('apple-script');
  });

  it('refuses QA, Karen, and ordinary callers as send authorizers', () => {
    for (const chatJid of ['tg:qa', 'tg:karen', 'tg:andrea-qa']) {
      expect(isNeverAuthorizeSendCaller({ group: mainGroup, chatJid })).toBe(
        true,
      );
      expect(
        isTrustedOwnerReviewSurface({
          channelName: 'telegram',
          chatJid,
          group: mainGroup,
        }),
      ).toBe(false);
    }
    expect(
      isTrustedOwnerReviewSurface({
        channelName: 'telegram',
        chatJid: 'tg:other',
        group: { ...mainGroup, isMain: false },
      }),
    ).toBe(false);
    expect(
      isNeverAuthorizeSendSurface(mainGroup, {
        chatJid: 'bb:iMessage;-;karen@example.invalid',
      }),
    ).toBe(false);
    expect(
      isNeverAuthorizeSendCaller({
        group: mainGroup,
        chatJid: 'bb:iMessage;-;karen@example.invalid',
      }),
    ).toBe(true);
    expect(
      isAuthorizedBlueBubblesSendCallerJid(
        'bb:iMessage;-;owner@example.invalid',
      ),
    ).toBe(true);
    expect(
      isAuthorizedBlueBubblesSendCallerJid('bb:iMessage;-;+12025550123'),
    ).toBe(false);
    expect(isAuthorizedBlueBubblesSendCallerJid('bb:chat-1')).toBe(true);
    expect(isAuthorizedBlueBubblesSendCallerJid('bb:')).toBe(false);
    expect(
      isNeverAuthorizeSendCaller({ group: mainGroup, chatJid: 'bb:' }),
    ).toBe(true);
    expect(
      isNeverAuthorizeSendCaller({
        group: mainGroup,
        chatJid: 'slack:general',
      }),
    ).toBe(true);
  });

  it('keeps short BlueBubbles caller JIDs inside the hermetic test boundary', () => {
    process.env.ANDREA_TEST_DISABLE_OWNER_ENV_FILE = '1';
    vi.stubEnv('NODE_ENV', 'production');

    expect(isAuthorizedBlueBubblesSendCallerJid('bb:chat-1')).toBe(false);
    expect(
      isNeverAuthorizeSendCaller({ group: mainGroup, chatJid: 'bb:chat-1' }),
    ).toBe(true);

    vi.stubEnv('NODE_ENV', 'test');
    expect(isAuthorizedBlueBubblesSendCallerJid('bb:chat-1')).toBe(true);
    expect(isAuthorizedBlueBubblesSendCallerJid('bb:chat\n1')).toBe(false);
  });

  it('keeps short Telegram caller JIDs inside the hermetic test boundary', () => {
    process.env.ANDREA_TEST_DISABLE_OWNER_ENV_FILE = '1';
    vi.stubEnv('NODE_ENV', 'production');

    expect(isAuthorizedTelegramSendCallerJid('tg:main')).toBe(false);
    expect(isAuthorizedTelegramSendCallerJid('tg:100')).toBe(false);
    expect(isAuthorizedTelegramSendCallerJid('tg:12345')).toBe(false);
    expect(isAuthorizedTelegramSendCallerJid('tg:')).toBe(false);
    expect(isAuthorizedTelegramSendCallerJid('tg:undefined')).toBe(false);
    expect(
      isNeverAuthorizeSendCaller({ group: mainGroup, chatJid: 'tg:main' }),
    ).toBe(true);
    expect(
      isTrustedOwnerReviewSurface({
        channelName: 'telegram',
        chatJid: 'tg:main',
        group: mainGroup,
      }),
    ).toBe(false);

    vi.stubEnv('NODE_ENV', 'test');
    expect(isAuthorizedTelegramSendCallerJid('tg:main')).toBe(true);
    expect(isAuthorizedTelegramSendCallerJid('tg:100')).toBe(true);
    expect(isAuthorizedTelegramSendCallerJid('tg:')).toBe(false);
    expect(isAuthorizedTelegramSendCallerJid('tg:undefined')).toBe(false);
    expect(isAuthorizedTelegramSendCallerJid('tg:null')).toBe(false);
    expect(isAuthorizedTelegramSendCallerJid('tg:NaN')).toBe(false);
    expect(isAuthorizedTelegramSendCallerJid('tg:mai\nn')).toBe(false);
  });

  it('does not let empty, sentinel, or control-character Telegram JIDs stage or send', async () => {
    seedRecipient();
    const sendToTarget = vi.fn();
    const leftoverCallers = [
      'tg:',
      'tg:undefined',
      'tg:null',
      'tg:NaN',
      'tg:mai\nn',
    ];

    for (const chatJid of leftoverCallers) {
      expect(isNeverAuthorizeSendCaller({ group: mainGroup, chatJid })).toBe(
        true,
      );
      expect(
        isTrustedOwnerReviewSurface({
          channelName: 'telegram',
          chatJid,
          group: mainGroup,
        }),
      ).toBe(false);

      const staged = stageBlueBubblesOutboundRequest({
        groupFolder: 'main',
        channel: 'telegram',
        chatJid,
        group: mainGroup,
        rawText: 'Text Avery Example: Dinner is ready.',
      });
      const executed = await executeBlueBubblesOutboundRequest({
        groupFolder: 'main',
        channel: 'telegram',
        chatJid,
        group: mainGroup,
        rawText: 'Text Avery Example: Dinner is ready.',
        inboundMessageId: `leftover-exec-${encodeURIComponent(chatJid)}`,
        capabilityFacts: {
          toolRegistered: true,
          toolExposed: true,
          providerHealth: 'healthy',
          writePermission: 'granted',
          confirmation: 'satisfied',
        },
        executionDeps: {
          groupFolder: 'main',
          channel: 'telegram',
          chatJid,
          sendToTarget,
        },
      });
      const turned = await executeBlueBubblesOutboundTurn({
        groupFolder: 'main',
        channel: 'telegram',
        chatJid,
        group: mainGroup,
        rawText: 'Text Avery Example: Dinner is ready.',
        inboundMessageId: `leftover-turn-${encodeURIComponent(chatJid)}`,
        executionDeps: {
          groupFolder: 'main',
          channel: 'telegram',
          chatJid,
          sendToTarget,
        },
      });

      expect(staged).toMatchObject({ handled: true, state: 'restricted' });
      expect(executed).toMatchObject({ handled: true, state: 'restricted' });
      expect(turned).toMatchObject({ handled: true, state: 'restricted' });
    }

    expect(sendToTarget).not.toHaveBeenCalled();
    expect(
      listMessageActionsForGroup({ groupFolder: 'main', includeSent: true }),
    ).toHaveLength(0);
  });

  it('does not let empty or sentinel Telegram JIDs approve or defer a Bob draft', async () => {
    seedRecipient();
    const staged = stageBlueBubblesOutboundRequest({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:main',
      group: mainGroup,
      rawText: 'Text Avery Example: Dinner is ready.',
      inboundMessageId: 'bob-staged-leftover-card',
      now: new Date('2026-08-26T18:12:00.000Z'),
    });
    if (!staged.handled || staged.state !== 'staged') {
      throw new Error('expected Bob fixture to stage a draft');
    }
    updateMessageAction(staged.action.messageActionId, {
      presentationMessageId: 'tg:bob-leftover-card',
      lastUpdatedAt: '2026-08-26T18:12:30.000Z',
    });

    const sendToTarget = vi.fn(async () => ({
      platformMessageId: 'bb:should-not-send-leftover',
    }));

    for (const chatJid of ['tg:', 'tg:undefined', 'tg:null', 'tg:NaN']) {
      const blockedSend = await applyMessageActionOperation(
        staged.action.messageActionId,
        { kind: 'send' },
        {
          groupFolder: 'main',
          channel: 'telegram',
          chatJid,
          currentTime: new Date('2026-08-26T18:13:00.000Z'),
          ownerReviewGroup: mainGroup,
          sendToTarget,
        },
      );
      const blockedRewrite = await applyMessageActionOperation(
        staged.action.messageActionId,
        { kind: 'rewrite_and_send', style: 'shorter' },
        {
          groupFolder: 'main',
          channel: 'telegram',
          chatJid,
          currentTime: new Date('2026-08-26T18:13:10.000Z'),
          ownerReviewGroup: mainGroup,
          sendToTarget,
        },
      );
      const blockedDefer = await applyMessageActionOperation(
        staged.action.messageActionId,
        { kind: 'defer' },
        {
          groupFolder: 'main',
          channel: 'telegram',
          chatJid,
          currentTime: new Date('2026-08-26T18:13:20.000Z'),
          ownerReviewGroup: mainGroup,
          ownerAuthorizationAt: '2026-08-26T18:13:15.000Z',
          sendToTarget,
        },
      );

      expect(blockedSend.replyText).toContain('cannot authorize a send');
      expect(blockedRewrite.replyText).toContain('cannot authorize a send');
      expect(blockedDefer.replyText).toContain('cannot authorize a send');
    }

    expect(sendToTarget).not.toHaveBeenCalled();
    expect(getMessageAction(staged.action.messageActionId)).toMatchObject({
      sendStatus: 'drafted',
      scheduledTaskId: null,
    });
  });

  it('does not let a sentinel Telegram JID fire a scheduled send', async () => {
    vi.stubEnv('BLUEBUBBLES_SEND_ENABLED', 'true');
    seedRecipient();
    const thread = {
      id: 'comm-fence-scheduled-leftover',
      groupFolder: 'main',
      title: 'Avery Example',
      linkedSubjectIds: [],
      linkedLifeThreadIds: [],
      channel: 'bluebubbles' as const,
      channelChatJid: 'bb:iMessage;-;+12025550123',
      lastInboundSummary: 'Avery asked about dinner.',
      lastOutboundSummary: null,
      followupState: 'reply_needed' as const,
      urgency: 'tonight' as const,
      followupDueAt: '2026-08-26T22:00:00.000Z',
      suggestedNextAction: 'draft_reply' as const,
      toneStyleHints: [],
      lastContactAt: '2026-08-26T17:00:00.000Z',
      lastMessageId: 'bb:last-msg-leftover',
      linkedTaskId: null,
      inferenceState: 'user_confirmed' as const,
      trackingMode: 'default' as const,
      createdAt: '2026-08-26T16:30:00.000Z',
      updatedAt: '2026-08-26T18:30:00.000Z',
      disabledAt: null,
    };
    upsertCommunicationThread(thread);
    const action = createOrRefreshMessageActionFromDraft({
      groupFolder: 'main',
      presentationChannel: 'telegram',
      presentationChatJid: 'tg:main',
      sourceType: 'communication_thread',
      sourceKey: thread.id,
      sourceSummary: 'Avery still needs a dinner answer.',
      draftText: 'Yes, tonight still works for me.',
      personName: 'Avery Example',
      threadTitle: 'Avery Example',
      communicationThreadId: thread.id,
      communicationContext: 'reply_followthrough',
      now: new Date('2026-08-26T18:14:00.000Z'),
    });
    updateMessageAction(action.messageActionId, {
      presentationMessageId: 'tg:bob-scheduled-leftover-card',
      lastUpdatedAt: '2026-08-26T18:14:10.000Z',
    });
    await applyMessageActionOperation(
      action.messageActionId,
      { kind: 'defer' },
      {
        groupFolder: 'main',
        channel: 'telegram',
        chatJid: 'tg:main',
        currentTime: new Date('2026-08-26T18:14:20.000Z'),
        ownerAuthorizationAt: '2026-08-26T18:14:15.000Z',
        sendToTarget: vi.fn(async () => ({ platformMessageId: 'unused' })),
      },
    );
    const scheduled = getMessageAction(action.messageActionId)!;
    expect(scheduled.sendStatus).toBe('deferred');
    expect(scheduled.scheduledTaskId).toBeTruthy();

    const sendToTarget = vi.fn(async () => ({
      platformMessageId: 'bb:should-not-schedule-leftover',
    }));
    const runResult = await runScheduledMessageActionByTaskId(
      scheduled.scheduledTaskId!,
      {
        groupFolder: 'main',
        channel: 'telegram',
        chatJid: 'tg:undefined',
        currentTime: new Date('2026-08-26T21:00:00.000Z'),
        sendToTarget,
      },
    );

    expect(runResult.handled).toBe(true);
    expect(sendToTarget).not.toHaveBeenCalled();
    expect(getMessageAction(action.messageActionId)?.sendStatus).not.toBe(
      'sent',
    );
    expect(runResult.resultSummary).not.toMatch(/^Sent scheduled message/);
  });

  it('does not let an unauthorized caller stage or send', async () => {
    seedRecipient();
    const sendToTarget = vi.fn();

    for (const chatJid of ['tg:qa', 'tg:karen', 'tg:andrea-qa']) {
      const staged = stageBlueBubblesOutboundRequest({
        groupFolder: 'main',
        channel: 'telegram',
        chatJid,
        group: mainGroup,
        rawText: 'Text Avery Example: Dinner is ready.',
      });
      const executed = await executeBlueBubblesOutboundRequest({
        groupFolder: 'main',
        channel: 'telegram',
        chatJid,
        group: mainGroup,
        rawText: 'Text Avery Example: Dinner is ready.',
        inboundMessageId: `fence-exec-${chatJid}`,
        capabilityFacts: {
          toolRegistered: true,
          toolExposed: true,
          providerHealth: 'healthy',
          writePermission: 'granted',
          confirmation: 'satisfied',
        },
        executionDeps: {
          groupFolder: 'main',
          channel: 'telegram',
          chatJid,
          sendToTarget,
        },
      });
      const turned = await executeBlueBubblesOutboundTurn({
        groupFolder: 'main',
        channel: 'telegram',
        chatJid,
        group: mainGroup,
        rawText: 'Text Avery Example: Dinner is ready.',
        inboundMessageId: `fence-turn-${chatJid}`,
        executionDeps: {
          groupFolder: 'main',
          channel: 'telegram',
          chatJid,
          sendToTarget,
        },
      });

      expect(staged).toMatchObject({ handled: true, state: 'restricted' });
      expect(executed).toMatchObject({ handled: true, state: 'restricted' });
      expect(turned).toMatchObject({ handled: true, state: 'restricted' });
    }

    expect(sendToTarget).not.toHaveBeenCalled();
    expect(
      listMessageActionsForGroup({ groupFolder: 'main', includeSent: true }),
    ).toHaveLength(0);
  });

  it('does not let QA or Karen approve a draft that Bob already staged', async () => {
    seedRecipient();
    const staged = stageBlueBubblesOutboundRequest({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:main',
      group: mainGroup,
      rawText: 'Text Avery Example: Dinner is ready.',
      inboundMessageId: 'bob-staged-card',
      now: new Date('2026-08-23T18:05:00.000Z'),
    });
    if (!staged.handled || staged.state !== 'staged') {
      throw new Error('expected Bob to stage a draft');
    }
    updateMessageAction(staged.action.messageActionId, {
      presentationMessageId: 'tg:bob-card',
      lastUpdatedAt: '2026-08-23T18:05:30.000Z',
    });

    const sendToTarget = vi.fn(async () => ({
      platformMessageId: 'bb:should-not-send',
    }));

    for (const chatJid of ['tg:qa', 'tg:karen', 'tg:andrea-qa']) {
      const blocked = await applyMessageActionOperation(
        staged.action.messageActionId,
        { kind: 'send' },
        {
          groupFolder: 'main',
          channel: 'telegram',
          chatJid,
          currentTime: new Date('2026-08-23T18:06:00.000Z'),
          ownerReviewGroup: mainGroup,
          sendToTarget,
        },
      );

      expect(blocked.handled).toBe(true);
      expect(blocked.replyText).toContain('cannot authorize a send');
      expect(blocked.action?.sendStatus).not.toBe('sent');
    }

    const blockedWithoutGroup = await applyMessageActionOperation(
      staged.action.messageActionId,
      { kind: 'send' },
      {
        groupFolder: 'main',
        channel: 'telegram',
        chatJid: 'tg:qa',
        currentTime: new Date('2026-08-23T18:06:30.000Z'),
        sendToTarget,
      },
    );
    expect(blockedWithoutGroup.replyText).toContain('cannot authorize a send');

    expect(sendToTarget).not.toHaveBeenCalled();
    expect(getMessageAction(staged.action.messageActionId)?.sendStatus).toBe(
      'drafted',
    );
  });

  it('does not treat bare yes as send authorization', () => {
    for (const utterance of ['yes', 'Yes', 'yes.', 'ok', 'okay', 'y']) {
      expect(interpretMessageActionFollowup(utterance)).toBeNull();
    }
    expect(interpretMessageActionFollowup('send it')).toEqual({
      kind: 'send',
    });
    expect(interpretMessageActionFollowup('Send now')).toEqual({
      kind: 'send',
    });
  });

  it('refuses a numeric Telegram JID whose stored title is QA or Karen', async () => {
    seedRecipient();
    const sendToTarget = vi.fn();

    for (const { chatJid, title } of [
      { chatJid: 'tg:900100200', title: 'QA' },
      { chatJid: 'tg:900100201', title: 'Karen' },
    ]) {
      storeChatMetadata(
        chatJid,
        '2026-08-23T00:00:00.000Z',
        title,
        'telegram',
        false,
      );
      expect(getChatName(chatJid)).toBe(title);
      expect(isNeverAuthorizeSendCaller({ group: mainGroup, chatJid })).toBe(
        true,
      );
      expect(
        isTrustedOwnerReviewSurface({
          channelName: 'telegram',
          chatJid,
          group: mainGroup,
        }),
      ).toBe(false);

      const staged = stageBlueBubblesOutboundRequest({
        groupFolder: 'main',
        channel: 'telegram',
        chatJid,
        group: mainGroup,
        rawText: 'Text Avery Example: Dinner is ready.',
      });
      const executed = await executeBlueBubblesOutboundRequest({
        groupFolder: 'main',
        channel: 'telegram',
        chatJid,
        group: mainGroup,
        rawText: 'Text Avery Example: Dinner is ready.',
        inboundMessageId: `numeric-title-${chatJid}`,
        capabilityFacts: {
          toolRegistered: true,
          toolExposed: true,
          providerHealth: 'healthy',
          writePermission: 'granted',
          confirmation: 'satisfied',
        },
        executionDeps: {
          groupFolder: 'main',
          channel: 'telegram',
          chatJid,
          sendToTarget,
        },
      });
      const turned = await executeBlueBubblesOutboundTurn({
        groupFolder: 'main',
        channel: 'telegram',
        chatJid,
        group: mainGroup,
        rawText: 'Text Avery Example: Dinner is ready.',
        inboundMessageId: `numeric-turn-${chatJid}`,
        executionDeps: {
          groupFolder: 'main',
          channel: 'telegram',
          chatJid,
          sendToTarget,
        },
      });

      expect(staged).toMatchObject({ handled: true, state: 'restricted' });
      expect(executed).toMatchObject({ handled: true, state: 'restricted' });
      expect(turned).toMatchObject({ handled: true, state: 'restricted' });
    }

    expect(sendToTarget).not.toHaveBeenCalled();
    expect(
      listMessageActionsForGroup({ groupFolder: 'main', includeSent: true }),
    ).toHaveLength(0);
  });

  it('does not let a numeric QA title approve or resend a draft Bob already staged', async () => {
    seedRecipient();
    const staged = stageBlueBubblesOutboundRequest({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:main',
      group: mainGroup,
      rawText: 'Text Avery Example: Dinner is ready.',
      inboundMessageId: 'bob-staged-numeric-card',
      now: new Date('2026-08-23T18:07:00.000Z'),
    });
    if (!staged.handled || staged.state !== 'staged') {
      throw new Error('expected Bob to stage a draft');
    }
    updateMessageAction(staged.action.messageActionId, {
      presentationMessageId: 'tg:bob-numeric-card',
      lastUpdatedAt: '2026-08-23T18:07:30.000Z',
    });
    storeChatMetadata(
      'tg:900100200',
      '2026-08-23T00:00:00.000Z',
      'QA',
      'telegram',
      false,
    );

    const sendToTarget = vi.fn(async () => ({
      platformMessageId: 'bb:should-not-send-numeric',
    }));
    const blocked = await applyMessageActionOperation(
      staged.action.messageActionId,
      { kind: 'send' },
      {
        groupFolder: 'main',
        channel: 'telegram',
        chatJid: 'tg:900100200',
        currentTime: new Date('2026-08-23T18:08:00.000Z'),
        ownerReviewGroup: mainGroup,
        sendToTarget,
      },
    );

    expect(blocked.replyText).toContain('cannot authorize a send');
    expect(sendToTarget).not.toHaveBeenCalled();
    expect(getMessageAction(staged.action.messageActionId)?.sendStatus).toBe(
      'drafted',
    );
  });

  it('lets Bob approve a staged draft and still refuses QA send-again', async () => {
    seedRecipient();
    const staged = stageBlueBubblesOutboundRequest({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:main',
      group: mainGroup,
      rawText: 'Text Avery Example: Dinner is ready.',
      inboundMessageId: 'bob-yes-fence-card',
      now: new Date('2026-08-23T18:09:00.000Z'),
    });
    if (!staged.handled || staged.state !== 'staged') {
      throw new Error('expected Bob to stage a draft');
    }
    updateMessageAction(staged.action.messageActionId, {
      presentationMessageId: 'tg:bob-yes-card',
      lastUpdatedAt: '2026-08-23T18:09:30.000Z',
    });

    const sendToTarget = vi.fn(async () => ({
      platformMessageId: 'bb:bob-authorized-send',
    }));
    const sent = await applyMessageActionOperation(
      staged.action.messageActionId,
      { kind: 'send' },
      {
        groupFolder: 'main',
        channel: 'telegram',
        chatJid: 'tg:main',
        currentTime: new Date('2026-08-23T18:10:00.000Z'),
        ownerReviewGroup: mainGroup,
        sendToTarget,
      },
    );

    expect(sent.handled).toBe(true);
    expect(sent.action?.sendStatus).toBe('sent');
    expect(sendToTarget).toHaveBeenCalledTimes(1);

    const blockedAgain = await applyMessageActionOperation(
      staged.action.messageActionId,
      { kind: 'send_again' },
      {
        groupFolder: 'main',
        channel: 'telegram',
        chatJid: 'tg:qa',
        currentTime: new Date('2026-08-23T18:10:30.000Z'),
        ownerReviewGroup: mainGroup,
        sendToTarget,
      },
    );

    expect(blockedAgain.handled).toBe(true);
    expect(blockedAgain.action?.sendStatus).toBe('sent');
    expect(blockedAgain.replyText).toMatch(
      /cannot authorize a send|will not resend/,
    );
    expect(sendToTarget).toHaveBeenCalledTimes(1);
  });

  it('does not let a stored QA title fire a scheduled send', async () => {
    vi.stubEnv('BLUEBUBBLES_SEND_ENABLED', 'true');
    const thread = {
      id: 'comm-fence-scheduled-qa',
      groupFolder: 'main',
      title: 'Avery Example',
      linkedSubjectIds: [],
      linkedLifeThreadIds: [],
      channel: 'bluebubbles' as const,
      channelChatJid: 'bb:iMessage;-;+12025550123',
      lastInboundSummary: 'Avery asked about dinner.',
      lastOutboundSummary: null,
      followupState: 'reply_needed' as const,
      urgency: 'tonight' as const,
      followupDueAt: '2026-08-23T22:00:00.000Z',
      suggestedNextAction: 'draft_reply' as const,
      toneStyleHints: [],
      lastContactAt: '2026-08-23T17:00:00.000Z',
      lastMessageId: 'bb:last-msg-fence',
      linkedTaskId: null,
      inferenceState: 'user_confirmed' as const,
      trackingMode: 'default' as const,
      createdAt: '2026-08-23T16:30:00.000Z',
      updatedAt: '2026-08-23T18:30:00.000Z',
      disabledAt: null,
    };
    upsertCommunicationThread(thread);
    const action = createOrRefreshMessageActionFromDraft({
      groupFolder: 'main',
      presentationChannel: 'telegram',
      presentationChatJid: 'tg:main',
      sourceType: 'communication_thread',
      sourceKey: thread.id,
      sourceSummary: 'Avery still needs a dinner answer.',
      draftText: 'Yes, tonight still works for me.',
      personName: 'Avery Example',
      threadTitle: 'Avery Example',
      communicationThreadId: thread.id,
      communicationContext: 'reply_followthrough',
      now: new Date('2026-08-23T18:11:00.000Z'),
    });
    updateMessageAction(action.messageActionId, {
      presentationMessageId: 'tg:bob-scheduled-card',
      lastUpdatedAt: '2026-08-23T18:11:10.000Z',
    });
    await applyMessageActionOperation(
      action.messageActionId,
      { kind: 'defer' },
      {
        groupFolder: 'main',
        channel: 'telegram',
        chatJid: 'tg:main',
        currentTime: new Date('2026-08-23T18:11:20.000Z'),
        ownerAuthorizationAt: '2026-08-23T18:11:15.000Z',
        sendToTarget: vi.fn(async () => ({ platformMessageId: 'unused' })),
      },
    );
    const scheduled = getMessageAction(action.messageActionId)!;
    storeChatMetadata(
      'tg:900100200',
      '2026-08-23T00:00:00.000Z',
      'QA',
      'telegram',
      false,
    );
    const sendToTarget = vi.fn(async () => ({
      platformMessageId: 'bb:should-not-schedule-send',
    }));

    const runResult = await runScheduledMessageActionByTaskId(
      scheduled.scheduledTaskId!,
      {
        groupFolder: 'main',
        channel: 'telegram',
        chatJid: 'tg:900100200',
        currentTime: new Date('2026-08-23T21:00:00.000Z'),
        sendToTarget,
      },
    );

    expect(runResult.handled).toBe(true);
    expect(sendToTarget).not.toHaveBeenCalled();
    expect(getMessageAction(action.messageActionId)?.sendStatus).not.toBe(
      'sent',
    );
    expect(runResult.resultSummary).not.toMatch(/^Sent scheduled message/);
  });

  it('never grants send authority from a missing group', () => {
    expect(
      isTrustedOwnerReviewSurface({
        channelName: 'telegram',
        chatJid: 'tg:main',
        group: null,
      }),
    ).toBe(false);
    expect(
      isNeverAuthorizeSendCaller({
        group: null,
        chatJid: 'tg:qa',
      }),
    ).toBe(true);
    expect(
      isNeverAuthorizeSendCaller({
        chatJid: 'tg:main',
      }),
    ).toBe(false);
    expect(isNeverAuthorizeSendCaller({ group: mainGroup })).toBe(true);
    expect(
      isNeverAuthorizeSendCaller({
        group: mainGroup,
        chatJid: '',
      }),
    ).toBe(true);
    expect(
      isNeverAuthorizeSendCaller({
        group: mainGroup,
        chatJid: '   ',
      }),
    ).toBe(true);
    expect(
      isTrustedOwnerReviewSurface({
        channelName: 'telegram',
        chatJid: '   ',
        group: mainGroup,
      }),
    ).toBe(false);
  });

  it('does not let a provided title hide a stored QA or Karen title', () => {
    for (const { chatJid, title } of [
      { chatJid: 'tg:900100200', title: 'QA' },
      { chatJid: 'tg:900100201', title: 'Karen' },
    ]) {
      storeChatMetadata(
        chatJid,
        '2026-08-23T00:00:00.000Z',
        title,
        'telegram',
        false,
      );
      expect(getChatName(chatJid)).toBe(title);
      expect(
        isNeverAuthorizeSendCaller({
          group: mainGroup,
          chatJid,
          chatTitle: 'Main',
        }),
      ).toBe(true);
      expect(
        isNeverAuthorizeSendSurface(mainGroup, {
          chatJid,
          chatTitle: 'Bob',
        }),
      ).toBe(true);
      expect(
        isTrustedOwnerReviewSurface({
          channelName: 'telegram',
          chatJid,
          group: mainGroup,
          chatTitle: 'Main',
        }),
      ).toBe(false);
    }
  });

  it('does not let an unregistered numeric JID borrow isMain to stage or send', async () => {
    seedRecipient();
    expect(resolveRegisteredTelegramFrontDoorJid()).toBeNull();
    expect(isAuthorizedTelegramSendCallerJid('tg:main')).toBe(true);
    expect(isAuthorizedTelegramSendCallerJid('tg:100')).toBe(true);
    expect(isAuthorizedTelegramSendCallerJid('tg:847392018')).toBe(false);
    expect(isAuthorizedTelegramSendCallerJid('tg:100000')).toBe(false);

    const sendToTarget = vi.fn();
    for (const chatJid of ['tg:847392018', 'tg:900100200']) {
      expect(getChatName(chatJid)).toBeNull();
      expect(isNeverAuthorizeSendCaller({ group: mainGroup, chatJid })).toBe(
        true,
      );
      expect(
        isTrustedOwnerReviewSurface({
          channelName: 'telegram',
          chatJid,
          group: mainGroup,
        }),
      ).toBe(false);

      const staged = stageBlueBubblesOutboundRequest({
        groupFolder: 'main',
        channel: 'telegram',
        chatJid,
        group: mainGroup,
        rawText: 'Text Avery Example: Dinner is ready.',
      });
      const executed = await executeBlueBubblesOutboundRequest({
        groupFolder: 'main',
        channel: 'telegram',
        chatJid,
        group: mainGroup,
        rawText: 'Text Avery Example: Dinner is ready.',
        inboundMessageId: `unregistered-${chatJid}`,
        capabilityFacts: {
          toolRegistered: true,
          toolExposed: true,
          providerHealth: 'healthy',
          writePermission: 'granted',
          confirmation: 'satisfied',
        },
        executionDeps: {
          groupFolder: 'main',
          channel: 'telegram',
          chatJid,
          sendToTarget,
        },
      });
      const turned = await executeBlueBubblesOutboundTurn({
        groupFolder: 'main',
        channel: 'telegram',
        chatJid,
        group: mainGroup,
        rawText: 'Text Avery Example: Dinner is ready.',
        inboundMessageId: `unregistered-turn-${chatJid}`,
        executionDeps: {
          groupFolder: 'main',
          channel: 'telegram',
          chatJid,
          sendToTarget,
        },
      });

      expect(staged).toMatchObject({ handled: true, state: 'restricted' });
      expect(executed).toMatchObject({ handled: true, state: 'restricted' });
      expect(turned).toMatchObject({ handled: true, state: 'restricted' });
    }

    expect(
      isTrustedOwnerReviewSurface({
        channelName: 'telegram',
        chatJid: 'tg:main',
        group: mainGroup,
      }),
    ).toBe(true);
    expect(sendToTarget).not.toHaveBeenCalled();
    expect(
      listMessageActionsForGroup({ groupFolder: 'main', includeSent: true }),
    ).toHaveLength(0);
  });

  it('does not let an unregistered numeric JID approve, rewrite-and-send, or defer a Bob draft', async () => {
    seedRecipient();
    expect(resolveRegisteredTelegramFrontDoorJid()).toBeNull();
    const staged = stageBlueBubblesOutboundRequest({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:main',
      group: mainGroup,
      rawText: 'Text Avery Example: Dinner is ready.',
      inboundMessageId: 'bob-staged-unregistered-card',
      now: new Date('2026-08-23T18:15:00.000Z'),
    });
    if (!staged.handled || staged.state !== 'staged') {
      throw new Error('expected Bob fixture to stage a draft');
    }
    updateMessageAction(staged.action.messageActionId, {
      presentationMessageId: 'tg:bob-unregistered-card',
      lastUpdatedAt: '2026-08-23T18:15:30.000Z',
    });

    const sendToTarget = vi.fn(async () => ({
      platformMessageId: 'bb:should-not-send-unregistered',
    }));
    const blockedSend = await applyMessageActionOperation(
      staged.action.messageActionId,
      { kind: 'send' },
      {
        groupFolder: 'main',
        channel: 'telegram',
        chatJid: 'tg:847392018',
        currentTime: new Date('2026-08-23T18:16:00.000Z'),
        ownerReviewGroup: mainGroup,
        sendToTarget,
      },
    );
    const blockedRewrite = await applyMessageActionOperation(
      staged.action.messageActionId,
      { kind: 'rewrite_and_send', style: 'shorter' },
      {
        groupFolder: 'main',
        channel: 'telegram',
        chatJid: 'tg:847392018',
        currentTime: new Date('2026-08-23T18:16:10.000Z'),
        ownerReviewGroup: mainGroup,
        sendToTarget,
      },
    );
    const blockedDefer = await applyMessageActionOperation(
      staged.action.messageActionId,
      { kind: 'defer' },
      {
        groupFolder: 'main',
        channel: 'telegram',
        chatJid: 'tg:847392018',
        currentTime: new Date('2026-08-23T18:16:20.000Z'),
        ownerReviewGroup: mainGroup,
        ownerAuthorizationAt: '2026-08-23T18:16:15.000Z',
        sendToTarget,
      },
    );

    expect(blockedSend.replyText).toContain('cannot authorize a send');
    expect(blockedRewrite.replyText).toContain('cannot authorize a send');
    expect(blockedDefer.replyText).toContain('cannot authorize a send');
    expect(sendToTarget).not.toHaveBeenCalled();
    expect(getMessageAction(staged.action.messageActionId)).toMatchObject({
      sendStatus: 'drafted',
      scheduledTaskId: null,
    });
  });

  it('does not let an unregistered numeric JID fire a scheduled send', async () => {
    vi.stubEnv('BLUEBUBBLES_SEND_ENABLED', 'true');
    seedRecipient();
    expect(resolveRegisteredTelegramFrontDoorJid()).toBeNull();
    const thread = {
      id: 'comm-fence-scheduled-unregistered',
      groupFolder: 'main',
      title: 'Avery Example',
      linkedSubjectIds: [],
      linkedLifeThreadIds: [],
      channel: 'bluebubbles' as const,
      channelChatJid: 'bb:iMessage;-;+12025550123',
      lastInboundSummary: 'Avery asked about dinner.',
      lastOutboundSummary: null,
      followupState: 'reply_needed' as const,
      urgency: 'tonight' as const,
      followupDueAt: '2026-08-23T22:00:00.000Z',
      suggestedNextAction: 'draft_reply' as const,
      toneStyleHints: [],
      lastContactAt: '2026-08-23T17:00:00.000Z',
      lastMessageId: 'bb:last-msg-unregistered',
      linkedTaskId: null,
      inferenceState: 'user_confirmed' as const,
      trackingMode: 'default' as const,
      createdAt: '2026-08-23T16:30:00.000Z',
      updatedAt: '2026-08-23T18:30:00.000Z',
      disabledAt: null,
    };
    upsertCommunicationThread(thread);
    const action = createOrRefreshMessageActionFromDraft({
      groupFolder: 'main',
      presentationChannel: 'telegram',
      presentationChatJid: 'tg:main',
      sourceType: 'communication_thread',
      sourceKey: thread.id,
      sourceSummary: 'Avery still needs a dinner answer.',
      draftText: 'Yes, tonight still works for me.',
      personName: 'Avery Example',
      threadTitle: 'Avery Example',
      communicationThreadId: thread.id,
      communicationContext: 'reply_followthrough',
      now: new Date('2026-08-23T18:17:00.000Z'),
    });
    updateMessageAction(action.messageActionId, {
      presentationMessageId: 'tg:bob-scheduled-unregistered-card',
      lastUpdatedAt: '2026-08-23T18:17:10.000Z',
    });
    await applyMessageActionOperation(
      action.messageActionId,
      { kind: 'defer' },
      {
        groupFolder: 'main',
        channel: 'telegram',
        chatJid: 'tg:main',
        currentTime: new Date('2026-08-23T18:17:20.000Z'),
        ownerAuthorizationAt: '2026-08-23T18:17:15.000Z',
        sendToTarget: vi.fn(async () => ({ platformMessageId: 'unused' })),
      },
    );
    const scheduled = getMessageAction(action.messageActionId)!;
    expect(scheduled.sendStatus).toBe('deferred');
    expect(scheduled.scheduledTaskId).toBeTruthy();
    expect(getChatName('tg:847392018')).toBeNull();

    const sendToTarget = vi.fn(async () => ({
      platformMessageId: 'bb:should-not-schedule-unregistered',
    }));
    const runResult = await runScheduledMessageActionByTaskId(
      scheduled.scheduledTaskId!,
      {
        groupFolder: 'main',
        channel: 'telegram',
        chatJid: 'tg:847392018',
        currentTime: new Date('2026-08-23T21:00:00.000Z'),
        sendToTarget,
      },
    );

    expect(runResult.handled).toBe(true);
    expect(sendToTarget).not.toHaveBeenCalled();
    expect(getMessageAction(action.messageActionId)?.sendStatus).not.toBe(
      'sent',
    );
    expect(runResult.resultSummary).not.toMatch(/^Sent scheduled message/);
  });

  it('refuses a numeric Telegram JID that is not the registered front-door', async () => {
    seedRecipient();
    registerBobFrontDoor();
    expect(resolveRegisteredTelegramFrontDoorJid()).toBe('tg:main');
    expect(isRegisteredTelegramFrontDoorJid('tg:main')).toBe(true);
    expect(isRegisteredTelegramFrontDoorJid('tg:900100200')).toBe(false);

    const sendToTarget = vi.fn();
    for (const chatJid of ['tg:900100200', 'tg:847392018']) {
      expect(getChatName(chatJid)).toBeNull();
      expect(isNeverAuthorizeSendCaller({ group: mainGroup, chatJid })).toBe(
        true,
      );
      expect(
        isTrustedOwnerReviewSurface({
          channelName: 'telegram',
          chatJid,
          group: mainGroup,
        }),
      ).toBe(false);

      const staged = stageBlueBubblesOutboundRequest({
        groupFolder: 'main',
        channel: 'telegram',
        chatJid,
        group: mainGroup,
        rawText: 'Text Avery Example: Dinner is ready.',
      });
      const executed = await executeBlueBubblesOutboundRequest({
        groupFolder: 'main',
        channel: 'telegram',
        chatJid,
        group: mainGroup,
        rawText: 'Text Avery Example: Dinner is ready.',
        inboundMessageId: `front-door-${chatJid}`,
        capabilityFacts: {
          toolRegistered: true,
          toolExposed: true,
          providerHealth: 'healthy',
          writePermission: 'granted',
          confirmation: 'satisfied',
        },
        executionDeps: {
          groupFolder: 'main',
          channel: 'telegram',
          chatJid,
          sendToTarget,
        },
      });
      const turned = await executeBlueBubblesOutboundTurn({
        groupFolder: 'main',
        channel: 'telegram',
        chatJid,
        group: mainGroup,
        rawText: 'Text Avery Example: Dinner is ready.',
        inboundMessageId: `front-door-turn-${chatJid}`,
        executionDeps: {
          groupFolder: 'main',
          channel: 'telegram',
          chatJid,
          sendToTarget,
        },
      });

      expect(staged).toMatchObject({ handled: true, state: 'restricted' });
      expect(executed).toMatchObject({ handled: true, state: 'restricted' });
      expect(turned).toMatchObject({ handled: true, state: 'restricted' });
    }

    expect(
      isTrustedOwnerReviewSurface({
        channelName: 'telegram',
        chatJid: 'tg:main',
        group: mainGroup,
      }),
    ).toBe(true);
    expect(sendToTarget).not.toHaveBeenCalled();
    expect(
      listMessageActionsForGroup({ groupFolder: 'main', includeSent: true }),
    ).toHaveLength(0);
  });

  it('does not let a numeric non-front-door JID approve or defer a draft Bob already staged', async () => {
    seedRecipient();
    registerBobFrontDoor();
    const staged = stageBlueBubblesOutboundRequest({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:main',
      group: mainGroup,
      rawText: 'Text Avery Example: Dinner is ready.',
      inboundMessageId: 'bob-staged-front-door-card',
      now: new Date('2026-08-23T18:12:00.000Z'),
    });
    if (!staged.handled || staged.state !== 'staged') {
      throw new Error('expected Bob to stage a draft');
    }
    updateMessageAction(staged.action.messageActionId, {
      presentationMessageId: 'tg:bob-front-door-card',
      lastUpdatedAt: '2026-08-23T18:12:30.000Z',
    });

    const sendToTarget = vi.fn(async () => ({
      platformMessageId: 'bb:should-not-send-front-door',
    }));
    const blockedSend = await applyMessageActionOperation(
      staged.action.messageActionId,
      { kind: 'send' },
      {
        groupFolder: 'main',
        channel: 'telegram',
        chatJid: 'tg:900100200',
        currentTime: new Date('2026-08-23T18:13:00.000Z'),
        ownerReviewGroup: mainGroup,
        sendToTarget,
      },
    );
    const blockedDefer = await applyMessageActionOperation(
      staged.action.messageActionId,
      { kind: 'defer' },
      {
        groupFolder: 'main',
        channel: 'telegram',
        chatJid: 'tg:900100200',
        currentTime: new Date('2026-08-23T18:13:30.000Z'),
        ownerReviewGroup: mainGroup,
        ownerAuthorizationAt: '2026-08-23T18:13:20.000Z',
        sendToTarget,
      },
    );

    expect(blockedSend.replyText).toContain('cannot authorize a send');
    expect(blockedDefer.replyText).toContain('cannot authorize a send');
    expect(sendToTarget).not.toHaveBeenCalled();
    expect(getMessageAction(staged.action.messageActionId)).toMatchObject({
      sendStatus: 'drafted',
      scheduledTaskId: null,
    });
  });

  it('does not let a numeric non-front-door JID fire a scheduled send without a stored title', async () => {
    vi.stubEnv('BLUEBUBBLES_SEND_ENABLED', 'true');
    seedRecipient();
    registerBobFrontDoor();
    const thread = {
      id: 'comm-fence-scheduled-front-door',
      groupFolder: 'main',
      title: 'Avery Example',
      linkedSubjectIds: [],
      linkedLifeThreadIds: [],
      channel: 'bluebubbles' as const,
      channelChatJid: 'bb:iMessage;-;+12025550123',
      lastInboundSummary: 'Avery asked about dinner.',
      lastOutboundSummary: null,
      followupState: 'reply_needed' as const,
      urgency: 'tonight' as const,
      followupDueAt: '2026-08-23T22:00:00.000Z',
      suggestedNextAction: 'draft_reply' as const,
      toneStyleHints: [],
      lastContactAt: '2026-08-23T17:00:00.000Z',
      lastMessageId: 'bb:last-msg-front-door',
      linkedTaskId: null,
      inferenceState: 'user_confirmed' as const,
      trackingMode: 'default' as const,
      createdAt: '2026-08-23T16:30:00.000Z',
      updatedAt: '2026-08-23T18:30:00.000Z',
      disabledAt: null,
    };
    upsertCommunicationThread(thread);
    const action = createOrRefreshMessageActionFromDraft({
      groupFolder: 'main',
      presentationChannel: 'telegram',
      presentationChatJid: 'tg:main',
      sourceType: 'communication_thread',
      sourceKey: thread.id,
      sourceSummary: 'Avery still needs a dinner answer.',
      draftText: 'Yes, tonight still works for me.',
      personName: 'Avery Example',
      threadTitle: 'Avery Example',
      communicationThreadId: thread.id,
      communicationContext: 'reply_followthrough',
      now: new Date('2026-08-23T18:14:00.000Z'),
    });
    updateMessageAction(action.messageActionId, {
      presentationMessageId: 'tg:bob-scheduled-front-door-card',
      lastUpdatedAt: '2026-08-23T18:14:10.000Z',
    });
    await applyMessageActionOperation(
      action.messageActionId,
      { kind: 'defer' },
      {
        groupFolder: 'main',
        channel: 'telegram',
        chatJid: 'tg:main',
        currentTime: new Date('2026-08-23T18:14:20.000Z'),
        ownerAuthorizationAt: '2026-08-23T18:14:15.000Z',
        sendToTarget: vi.fn(async () => ({ platformMessageId: 'unused' })),
      },
    );
    const scheduled = getMessageAction(action.messageActionId)!;
    expect(scheduled.sendStatus).toBe('deferred');
    expect(scheduled.scheduledTaskId).toBeTruthy();
    expect(getChatName('tg:900100200')).toBeNull();

    const sendToTarget = vi.fn(async () => ({
      platformMessageId: 'bb:should-not-schedule-front-door',
    }));
    const runResult = await runScheduledMessageActionByTaskId(
      scheduled.scheduledTaskId!,
      {
        groupFolder: 'main',
        channel: 'telegram',
        chatJid: 'tg:900100200',
        currentTime: new Date('2026-08-23T21:00:00.000Z'),
        sendToTarget,
      },
    );

    expect(runResult.handled).toBe(true);
    expect(sendToTarget).not.toHaveBeenCalled();
    expect(getMessageAction(action.messageActionId)?.sendStatus).not.toBe(
      'sent',
    );
    expect(runResult.resultSummary).not.toMatch(/^Sent scheduled message/);
  });

  it('does not let a BlueBubbles contact JID approve or defer a draft Bob already staged', async () => {
    seedRecipient();
    const staged = stageBlueBubblesOutboundRequest({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:main',
      group: mainGroup,
      rawText: 'Text Avery Example: Dinner is ready.',
      inboundMessageId: 'bob-staged-bb-contact-card',
      now: new Date('2026-08-23T18:18:00.000Z'),
    });
    if (!staged.handled || staged.state !== 'staged') {
      throw new Error('expected Bob fixture to stage a draft');
    }
    updateMessageAction(staged.action.messageActionId, {
      presentationMessageId: 'tg:bob-bb-contact-card',
      lastUpdatedAt: '2026-08-23T18:18:30.000Z',
    });

    const sendToTarget = vi.fn(async () => ({
      platformMessageId: 'bb:should-not-send-contact',
    }));
    const contactJid = 'bb:iMessage;-;+12025550123';
    expect(getChatName(contactJid)).toBe('Avery Example');
    expect(
      isNeverAuthorizeSendCaller({ group: mainGroup, chatJid: contactJid }),
    ).toBe(true);

    const blockedSend = await applyMessageActionOperation(
      staged.action.messageActionId,
      { kind: 'send' },
      {
        groupFolder: 'main',
        channel: 'bluebubbles',
        chatJid: contactJid,
        currentTime: new Date('2026-08-23T18:19:00.000Z'),
        ownerReviewGroup: mainGroup,
        sendToTarget,
      },
    );
    const blockedRewrite = await applyMessageActionOperation(
      staged.action.messageActionId,
      { kind: 'rewrite_and_send', style: 'shorter' },
      {
        groupFolder: 'main',
        channel: 'bluebubbles',
        chatJid: contactJid,
        currentTime: new Date('2026-08-23T18:19:10.000Z'),
        ownerReviewGroup: mainGroup,
        sendToTarget,
      },
    );
    const blockedDefer = await applyMessageActionOperation(
      staged.action.messageActionId,
      { kind: 'defer' },
      {
        groupFolder: 'main',
        channel: 'bluebubbles',
        chatJid: contactJid,
        currentTime: new Date('2026-08-23T18:19:20.000Z'),
        ownerReviewGroup: mainGroup,
        ownerAuthorizationAt: '2026-08-23T18:19:15.000Z',
        sendToTarget,
      },
    );

    expect(blockedSend.replyText).toContain('cannot authorize a send');
    expect(blockedRewrite.replyText).toContain('cannot authorize a send');
    expect(blockedDefer.replyText).toContain('cannot authorize a send');
    expect(sendToTarget).not.toHaveBeenCalled();
    expect(getMessageAction(staged.action.messageActionId)).toMatchObject({
      sendStatus: 'drafted',
      scheduledTaskId: null,
    });
  });

  it('does not let a stored QA BlueBubbles title fire a scheduled send', async () => {
    vi.stubEnv('BLUEBUBBLES_SEND_ENABLED', 'true');
    seedRecipient();
    storeChatMetadata(
      'bb:iMessage;-;owner@example.invalid',
      '2026-08-23T00:00:00.000Z',
      'QA',
      'bluebubbles',
      false,
    );
    expect(getChatName('bb:iMessage;-;owner@example.invalid')).toBe('QA');
    expect(
      isNeverAuthorizeSendCaller({
        group: mainGroup,
        chatJid: 'bb:iMessage;-;owner@example.invalid',
      }),
    ).toBe(true);

    const thread = {
      id: 'comm-fence-scheduled-bb-qa-title',
      groupFolder: 'main',
      title: 'Avery Example',
      linkedSubjectIds: [],
      linkedLifeThreadIds: [],
      channel: 'bluebubbles' as const,
      channelChatJid: 'bb:iMessage;-;+12025550123',
      lastInboundSummary: 'Avery asked about dinner.',
      lastOutboundSummary: null,
      followupState: 'reply_needed' as const,
      urgency: 'tonight' as const,
      followupDueAt: '2026-08-23T22:00:00.000Z',
      suggestedNextAction: 'draft_reply' as const,
      toneStyleHints: [],
      lastContactAt: '2026-08-23T17:00:00.000Z',
      lastMessageId: 'bb:last-msg-bb-qa-title',
      linkedTaskId: null,
      inferenceState: 'user_confirmed' as const,
      trackingMode: 'default' as const,
      createdAt: '2026-08-23T16:30:00.000Z',
      updatedAt: '2026-08-23T18:30:00.000Z',
      disabledAt: null,
    };
    upsertCommunicationThread(thread);
    const action = createOrRefreshMessageActionFromDraft({
      groupFolder: 'main',
      presentationChannel: 'telegram',
      presentationChatJid: 'tg:main',
      sourceType: 'communication_thread',
      sourceKey: thread.id,
      sourceSummary: 'Avery still needs a dinner answer.',
      draftText: 'Yes, tonight still works for me.',
      personName: 'Avery Example',
      threadTitle: 'Avery Example',
      communicationThreadId: thread.id,
      communicationContext: 'reply_followthrough',
      now: new Date('2026-08-23T18:20:00.000Z'),
    });
    updateMessageAction(action.messageActionId, {
      presentationMessageId: 'tg:bob-scheduled-bb-qa-title-card',
      lastUpdatedAt: '2026-08-23T18:20:10.000Z',
    });
    await applyMessageActionOperation(
      action.messageActionId,
      { kind: 'defer' },
      {
        groupFolder: 'main',
        channel: 'telegram',
        chatJid: 'tg:main',
        currentTime: new Date('2026-08-23T18:20:20.000Z'),
        ownerAuthorizationAt: '2026-08-23T18:20:15.000Z',
        sendToTarget: vi.fn(async () => ({ platformMessageId: 'unused' })),
      },
    );
    const scheduled = getMessageAction(action.messageActionId)!;
    expect(scheduled.sendStatus).toBe('deferred');
    expect(scheduled.scheduledTaskId).toBeTruthy();

    const sendToTarget = vi.fn(async () => ({
      platformMessageId: 'bb:should-not-schedule-bb-qa-title',
    }));
    const runResult = await runScheduledMessageActionByTaskId(
      scheduled.scheduledTaskId!,
      {
        groupFolder: 'main',
        channel: 'bluebubbles',
        chatJid: 'bb:iMessage;-;owner@example.invalid',
        currentTime: new Date('2026-08-23T21:00:00.000Z'),
        sendToTarget,
      },
    );

    expect(runResult.handled).toBe(true);
    expect(sendToTarget).not.toHaveBeenCalled();
    expect(getMessageAction(action.messageActionId)?.sendStatus).not.toBe(
      'sent',
    );
    expect(runResult.resultSummary).not.toMatch(/^Sent scheduled message/);
  });
});
