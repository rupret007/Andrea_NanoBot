import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import './channels/index.js';

import {
  doContextBoundRecipientLabelsMatch,
  executeBlueBubblesOutboundTurn,
} from './bluebubbles-outbound-turn.js';
import { resolveBlueBubblesConfig } from './channels/bluebubbles.js';
import {
  _closeDatabase,
  _initTestDatabase,
  listMessageActionsForGroup,
  updateMessageAction,
} from './db.js';
import {
  applyMessageActionOperation,
  type MessageActionExecutionDeps,
} from './message-actions.js';
import { setMessagingOutboundPaused } from './messaging-outbound-pause.js';
import {
  DEFAULT_RUNTIME_CAPABILITY_DESCRIPTORS,
  RuntimeCapabilityRegistry,
  runtimeCapabilityRegistry,
} from './runtime-capability-registry.js';
import { registerProductionRuntimeCapabilitySurfaces } from './runtime-capability-production-surfaces.js';
import type {
  BlueBubblesChannelControlSnapshot,
  RegisteredGroup,
} from './types.js';

registerProductionRuntimeCapabilitySurfaces(runtimeCapabilityRegistry);

const mainGroup: RegisteredGroup = {
  name: 'Main',
  folder: 'main',
  trigger: '@Andrea',
  added_at: '2026-07-16T00:00:00.000Z',
  requiresTrigger: false,
  isMain: true,
};

const companionGroup: RegisteredGroup = {
  ...mainGroup,
  name: 'BlueBubbles (Main)',
  isMain: false,
};

function controlSnapshot(
  overrides: Partial<BlueBubblesChannelControlSnapshot> = {},
): BlueBubblesChannelControlSnapshot {
  return {
    connected: true,
    enabled: true,
    groupFolder: 'main',
    chatScope: 'contacts_only',
    sendEnabled: true,
    listenerHost: '127.0.0.1',
    listenerPort: 4305,
    configuredBaseUrl: 'http://bluebubbles.test',
    activeBaseUrl: 'http://bluebubbles.test',
    candidateBaseUrls: ['http://bluebubbles.test'],
    publicWebhookUrl: 'http://localhost/webhook',
    serverPublicUrl: null,
    localPort: null,
    imessageAccountLabel: null,
    computerId: null,
    webhookRegistrationState: 'registered',
    webhookRegistrationDetail: 'ok',
    transportState: 'reachable',
    transportDetail: 'current probe succeeded',
    receiptInboxState: 'reachable',
    shadowPollLastOkAt: 'none',
    shadowPollLastError: 'none',
    shadowPollMostRecentChat: 'none',
    configuredReplyGateMode: 'mention_required',
    effectiveReplyGateMode: 'mention_required',
    lastInboundObservedAt: 'none',
    lastInboundChatJid: 'none',
    lastInboundWasSelfAuthored: null,
    lastOutboundResult: 'none',
    lastOutboundTargetKind: 'none',
    lastOutboundTarget: 'none',
    lastSendErrorDetail: 'none',
    detectionState: 'healthy',
    detectionDetail: 'ok',
    detectionNextAction: 'none',
    ...overrides,
  };
}

function testConfig() {
  return {
    ...resolveBlueBubblesConfig(),
    enabled: true,
    sendEnabled: true,
    baseUrl: 'http://bluebubbles.test',
    password: 'test-password',
  };
}

describe('BlueBubbles production outbound turn boundary', () => {
  it('requires an exact normalized recipient label for numbered-review sends', () => {
    expect(doContextBoundRecipientLabelsMatch('Mary Ann', 'Mary Ann')).toBe(
      true,
    );
    expect(doContextBoundRecipientLabelsMatch('mary-ann', 'Mary Ann')).toBe(
      true,
    );
    expect(doContextBoundRecipientLabelsMatch(null, 'Mary Ann')).toBe(true);
    expect(doContextBoundRecipientLabelsMatch('Candace', 'Candace Story')).toBe(
      true,
    );
    expect(doContextBoundRecipientLabelsMatch('Mary', 'Mary Ann')).toBe(true);
    expect(doContextBoundRecipientLabelsMatch('Ann', 'Mary Ann')).toBe(false);
    expect(doContextBoundRecipientLabelsMatch('李雷', '李雷')).toBe(true);
    expect(doContextBoundRecipientLabelsMatch('李雷', '韩梅梅')).toBe(false);
    expect(doContextBoundRecipientLabelsMatch('!!!', 'Mary Ann')).toBe(false);
    expect(doContextBoundRecipientLabelsMatch('🎉?!', '🎉?!')).toBe(false);
    expect(
      doContextBoundRecipientLabelsMatch('Ｍａｒｙ　Ａｎｎ', 'Mary Ann'),
    ).toBe(true);
  });
  beforeEach(() => {
    vi.stubEnv('ANDREA_TEST_DISABLE_OWNER_ENV_FILE', '1');
    vi.stubEnv(
      'BLUEBUBBLES_CANONICAL_SELF_THREAD_JID',
      'iMessage;-;owner@example.invalid',
    );
    _initTestDatabase();
  });

  afterEach(() => {
    _closeDatabase();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('answers the real Telegram capability question from current BlueBubbles truth without dispatching', async () => {
    const refreshControlState = vi.fn(async () => controlSnapshot());
    const resolveStoredRecipient = vi.fn(() => ({
      state: 'missing' as const,
    }));
    const resolveLiveRecipient = vi.fn(async () => ({
      state: 'missing' as const,
    }));
    const sendToTarget = vi.fn();

    const result = await executeBlueBubblesOutboundTurn({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:main',
      group: mainGroup,
      rawText: 'You can’t send message on blue bubbles on my behalf?',
      inboundMessageId: 'tg-capability-truth',
      blueBubblesChannel: {
        getControlSnapshot: () =>
          controlSnapshot({ transportState: 'not_checked' }),
        refreshControlState,
      },
      resolveConfig: testConfig,
      resolveStoredRecipient,
      resolveLiveRecipient,
      executionDeps: {
        groupFolder: 'main',
        channel: 'telegram',
        chatJid: 'tg:main',
        sendToTarget,
      },
    });

    expect(result).toMatchObject({
      handled: true,
      state: 'capability_status',
    });
    expect(result).toHaveProperty(
      'replyText',
      expect.stringContaining('Yes. BlueBubbles is connected'),
    );
    expect(refreshControlState).toHaveBeenCalledWith('transport');
    expect(resolveStoredRecipient).not.toHaveBeenCalled();
    expect(resolveLiveRecipient).not.toHaveBeenCalled();
    expect(sendToTarget).not.toHaveBeenCalled();
  });

  it('reports the durable owner pause without probing BlueBubbles or looking up a recipient', async () => {
    const refreshControlState = vi.fn(async () => controlSnapshot());
    const resolveStoredRecipient = vi.fn(() => ({
      state: 'missing' as const,
    }));
    const resolveLiveRecipient = vi.fn(async () => ({
      state: 'missing' as const,
    }));
    const sendToTarget = vi.fn();
    setMessagingOutboundPaused({
      paused: true,
      changedByChatJid: 'tg:main',
      reason: 'owner_explicit_stop_instruction',
      now: new Date('2026-07-16T20:52:17.507Z'),
    });

    const result = await executeBlueBubblesOutboundTurn({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:main',
      group: mainGroup,
      rawText: 'You can’t send message on blue bubbles on my behalf?',
      inboundMessageId: 'tg-capability-paused',
      blueBubblesChannel: {
        getControlSnapshot: () => controlSnapshot(),
        refreshControlState,
      },
      resolveConfig: testConfig,
      resolveStoredRecipient,
      resolveLiveRecipient,
      executionDeps: {
        groupFolder: 'main',
        channel: 'telegram',
        chatJid: 'tg:main',
        sendToTarget,
      },
    });

    expect(result).toMatchObject({
      handled: true,
      state: 'capability_status',
    });
    expect(result).toHaveProperty(
      'replyText',
      expect.stringContaining('paused by your owner stop request'),
    );
    expect(refreshControlState).not.toHaveBeenCalled();
    expect(resolveStoredRecipient).not.toHaveBeenCalled();
    expect(resolveLiveRecipient).not.toHaveBeenCalled();
    expect(sendToTarget).not.toHaveBeenCalled();
  });

  it('blocks a fresh explicit send at the durable owner pause before any provider or recipient work', async () => {
    const refreshControlState = vi.fn(async () => controlSnapshot());
    const resolveStoredRecipient = vi.fn(() => ({
      state: 'resolved' as const,
      target: {
        chatJid: 'bb:iMessage;-;+12025550123',
        displayName: 'Avery Example',
        isGroup: false,
      },
    }));
    const resolveLiveRecipient = vi.fn(async () => ({
      state: 'missing' as const,
    }));
    const sendToTarget = vi.fn();

    const result = await executeBlueBubblesOutboundTurn({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:main',
      group: mainGroup,
      rawText: 'Text Avery Example: Dinner is ready.',
      inboundMessageId: 'tg-explicit-send-paused',
      isOutboundPaused: () => true,
      blueBubblesChannel: {
        getControlSnapshot: () => controlSnapshot(),
        refreshControlState,
      },
      resolveConfig: testConfig,
      resolveStoredRecipient,
      resolveLiveRecipient,
      executionDeps: {
        groupFolder: 'main',
        channel: 'telegram',
        chatJid: 'tg:main',
        sendToTarget,
      },
    });

    expect(result).toMatchObject({ handled: true, state: 'restricted' });
    expect(result).toHaveProperty(
      'replyText',
      expect.stringContaining('paused by your owner stop request'),
    );
    expect(refreshControlState).not.toHaveBeenCalled();
    expect(resolveStoredRecipient).not.toHaveBeenCalled();
    expect(resolveLiveRecipient).not.toHaveBeenCalled();
    expect(sendToTarget).not.toHaveBeenCalled();
  });

  it('reports a current BlueBubbles outage instead of inventing a permanent platform limitation', async () => {
    const refreshControlState = vi.fn(async () =>
      controlSnapshot({
        connected: false,
        transportState: 'unreachable',
        transportDetail: 'current probe failed',
      }),
    );
    const sendToTarget = vi.fn();

    const result = await executeBlueBubblesOutboundTurn({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:main',
      group: mainGroup,
      rawText: 'Can BlueBubbles send texts for me?',
      inboundMessageId: 'tg-capability-outage',
      blueBubblesChannel: {
        getControlSnapshot: () => controlSnapshot(),
        refreshControlState,
      },
      executionDeps: {
        groupFolder: 'main',
        channel: 'telegram',
        chatJid: 'tg:main',
        sendToTarget,
      },
    });

    expect(result).toMatchObject({
      handled: true,
      state: 'capability_status',
    });
    expect(result).toHaveProperty(
      'replyText',
      expect.stringContaining('not available right now'),
    );
    expect(result).toHaveProperty(
      'replyText',
      expect.stringContaining('provider is unhealthy'),
    );
    expect(sendToTarget).not.toHaveBeenCalled();
  });

  it.each([undefined, false] as const)(
    'rejects a configured BlueBubbles self-thread when ownerAuthored is %s before any provider work',
    async (ownerAuthored) => {
      const refreshControlState = vi.fn(async () => controlSnapshot());
      const resolveStoredRecipient = vi.fn(() => ({
        state: 'resolved' as const,
        target: {
          chatJid: 'bb:iMessage;-;+12025550123',
          displayName: 'Avery Example',
          isGroup: false,
        },
      }));
      const resolveLiveRecipient = vi.fn(async () => ({
        state: 'missing' as const,
      }));
      const sendToTarget = vi.fn();

      const result = await executeBlueBubblesOutboundTurn({
        groupFolder: 'main',
        channel: 'bluebubbles',
        chatJid: 'bb:iMessage;-;owner@example.invalid',
        group: companionGroup,
        ownerAuthored,
        rawText: 'Text Avery Example: Dinner is ready.',
        inboundMessageId: `bb-untrusted-${String(ownerAuthored)}`,
        blueBubblesChannel: {
          getControlSnapshot: () => controlSnapshot(),
          refreshControlState,
        },
        resolveConfig: testConfig,
        resolveStoredRecipient,
        resolveLiveRecipient,
        executionDeps: {
          groupFolder: 'main',
          channel: 'bluebubbles',
          chatJid: 'bb:iMessage;-;owner@example.invalid',
          sendToTarget,
        },
      });

      expect(result).toMatchObject({ handled: true, state: 'restricted' });
      expect(refreshControlState).not.toHaveBeenCalled();
      expect(resolveStoredRecipient).not.toHaveBeenCalled();
      expect(resolveLiveRecipient).not.toHaveBeenCalled();
      expect(sendToTarget).not.toHaveBeenCalled();
    },
  );

  it('does not read numbered-review context for a non-owner BlueBubbles turn', async () => {
    const resolveContextBoundRecipient = vi.fn();
    const refreshControlState = vi.fn();
    const sendToTarget = vi.fn();

    const result = await executeBlueBubblesOutboundTurn({
      groupFolder: 'main',
      channel: 'bluebubbles',
      chatJid: 'bb:iMessage;-;owner@example.invalid',
      group: companionGroup,
      ownerAuthored: false,
      rawText: 'Yes reply to 1 Casey saying yes I need her to pick up please.',
      inboundMessageId: 'bb-untrusted-numbered-review',
      blueBubblesChannel: {
        getControlSnapshot: () => controlSnapshot(),
        refreshControlState,
      },
      resolveContextBoundRecipient,
      executionDeps: {
        groupFolder: 'main',
        channel: 'bluebubbles',
        chatJid: 'bb:iMessage;-;owner@example.invalid',
        sendToTarget,
      },
    });

    expect(result).toMatchObject({ handled: true, state: 'restricted' });
    expect(resolveContextBoundRecipient).not.toHaveBeenCalled();
    expect(refreshControlState).not.toHaveBeenCalled();
    expect(sendToTarget).not.toHaveBeenCalled();
  });

  it('replays a verified numbered-review send before rebinding changed context', async () => {
    const resolveContextBoundRecipient = vi.fn(async () => ({
      state: 'resolved' as const,
      recipientResolution: {
        state: 'resolved' as const,
        target: {
          chatJid: 'bb:iMessage;-;+18176580310',
          displayName: 'Casey Example',
          isGroup: false,
        },
      },
    }));
    const refreshControlState = vi.fn(async () => controlSnapshot());
    const sendToTarget = vi.fn(async () => ({
      platformMessageId: 'bb:casey-numbered-receipt',
    }));
    const turnRequest = {
      groupFolder: 'main',
      channel: 'telegram' as const,
      chatJid: 'tg:main',
      group: mainGroup,
      rawText: 'Yes reply to 1 Casey saying yes I need her to pick up please.',
      inboundMessageId: 'tg-numbered-review-send',
      blueBubblesChannel: {
        getControlSnapshot: () => controlSnapshot(),
        refreshControlState,
      },
      resolveContextBoundRecipient,
      executionDeps: {
        groupFolder: 'main',
        channel: 'telegram' as const,
        chatJid: 'tg:main',
        sendToTarget,
      },
    };

    const result = await executeBlueBubblesOutboundTurn(turnRequest);
    expect(result).toMatchObject({
      handled: true,
      state: 'staged',
      action: { sendStatus: 'drafted', requiresApproval: true },
    });
    if (!result.handled || result.state !== 'staged') {
      throw new Error('expected a separately approved numbered-review draft');
    }
    expect(sendToTarget).not.toHaveBeenCalled();
    updateMessageAction(result.action.messageActionId, {
      presentationMessageId: 'tg:numbered-review-card',
      lastUpdatedAt: new Date().toISOString(),
    });
    const approved = await applyMessageActionOperation(
      result.action.messageActionId,
      { kind: 'send' },
      turnRequest.executionDeps,
    );
    expect(approved.action).toMatchObject({
      sendStatus: 'sent',
      platformMessageId: 'bb:casey-numbered-receipt',
    });
    expect(sendToTarget).toHaveBeenCalledWith(
      'bluebubbles',
      'bb:iMessage;-;+18176580310',
      'yes I need her to pick up please.',
      expect.objectContaining({ idempotencyKey: expect.any(String) }),
    );

    resolveContextBoundRecipient.mockRejectedValueOnce(
      new Error('review seed is now stale'),
    );
    const replay = await executeBlueBubblesOutboundTurn(turnRequest);
    expect(replay).toMatchObject({
      handled: true,
      state: 'sent',
      action: { platformMessageId: 'bb:casey-numbered-receipt' },
    });
    expect(resolveContextBoundRecipient).toHaveBeenCalledTimes(1);
    expect(refreshControlState).toHaveBeenCalledTimes(1);
    expect(sendToTarget).toHaveBeenCalledTimes(1);

    const replayWhilePaused = await executeBlueBubblesOutboundTurn({
      ...turnRequest,
      isOutboundPaused: () => true,
    });
    expect(replayWhilePaused).toMatchObject({
      handled: true,
      state: 'sent',
      action: { platformMessageId: 'bb:casey-numbered-receipt' },
    });
    expect(resolveContextBoundRecipient).toHaveBeenCalledTimes(1);
    expect(refreshControlState).toHaveBeenCalledTimes(1);
    expect(sendToTarget).toHaveBeenCalledTimes(1);
  });

  it('stages a synthetic recent-thread composite only against its context-bound recipient', async () => {
    const resolveContextBoundRecipient = vi.fn(async ({ intent }) => {
      expect(intent.contextBinding).toEqual({
        kind: 'recent_recipient_thread',
      });
      return {
        state: 'resolved' as const,
        recipientResolution: {
          state: 'resolved' as const,
          target: {
            chatJid: 'bb:iMessage;-;+18176580310',
            displayName: 'Casey Example',
            isGroup: false,
          },
        },
      };
    });
    const sendToTarget = vi.fn(async () => ({
      platformMessageId: 'bb:casey-composite-receipt',
    }));

    const result = await executeBlueBubblesOutboundTurn({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:main',
      group: mainGroup,
      rawText:
        'Hi can you use blue bubbles to send a message back to Casey please. Check my recent text from her and reply from you that yes, please bring the blue folder before the courier arrives.',
      inboundMessageId: 'tg-casey-composite',
      blueBubblesChannel: {
        getControlSnapshot: () => controlSnapshot(),
        refreshControlState: async () => controlSnapshot(),
      },
      resolveContextBoundRecipient,
      executionDeps: {
        groupFolder: 'main',
        channel: 'telegram',
        chatJid: 'tg:main',
        sendToTarget,
      },
    });

    expect(result).toMatchObject({
      handled: true,
      state: 'staged',
      action: {
        draftText:
          'yes, please bring the blue folder before the courier arrives.',
        sendStatus: 'drafted',
        requiresApproval: true,
      },
    });
    expect(resolveContextBoundRecipient).toHaveBeenCalledTimes(1);
    expect(sendToTarget).not.toHaveBeenCalled();
  });

  it('allows an owner-authored configured BlueBubbles self-thread turn through offline provider spies', async () => {
    const refreshControlState = vi.fn(async () => controlSnapshot());
    const resolveStoredRecipient = vi.fn(() => ({
      state: 'resolved' as const,
      target: {
        chatJid: 'bb:iMessage;-;+12025550123',
        displayName: 'Avery Example',
        isGroup: false,
      },
    }));
    const resolveLiveRecipient = vi.fn(async () => ({
      state: 'missing' as const,
    }));
    const sendToTarget = vi.fn(async () => ({
      platformMessageId: 'bb:offline-owner-receipt',
    }));

    const result = await executeBlueBubblesOutboundTurn({
      groupFolder: 'main',
      channel: 'bluebubbles',
      chatJid: 'bb:iMessage;-;owner@example.invalid',
      group: companionGroup,
      ownerAuthored: true,
      rawText: 'Text Avery Example: Dinner is ready.',
      inboundMessageId: 'bb-owner-authored-true',
      blueBubblesChannel: {
        getControlSnapshot: () => controlSnapshot(),
        refreshControlState,
      },
      resolveConfig: testConfig,
      resolveStoredRecipient,
      resolveLiveRecipient,
      executionDeps: {
        groupFolder: 'main',
        channel: 'bluebubbles',
        chatJid: 'bb:iMessage;-;owner@example.invalid',
        sendToTarget,
      },
    });

    expect(result).toMatchObject({
      handled: true,
      state: 'staged',
      action: { sendStatus: 'drafted', requiresApproval: true },
    });
    expect(refreshControlState).toHaveBeenCalledWith('transport');
    expect(sendToTarget).not.toHaveBeenCalled();
  });

  it('resolves the exact recipient and stages a funny request without canned invented prose', async () => {
    const stale = controlSnapshot({
      transportState: 'unreachable',
      transportDetail: 'stale failure',
    });
    const fresh = controlSnapshot();
    const refreshControlState = vi.fn(async () => fresh);
    const resolveLiveRecipient = vi.fn(async () => ({
      state: 'resolved' as const,
      target: {
        chatJid: 'bb:iMessage;-;+12025550123',
        displayName: 'Avery Example',
        isGroup: false as const,
        blueBubblesCreateChatAddress: '+12025550123',
      },
    }));
    const resolveStoredRecipient = vi.fn(() => ({ state: 'missing' as const }));
    const sendToTarget = vi.fn(async () => ({
      platformMessageId: 'bb:provider-receipt-1',
      threadId: 'bb:iMessage;-;+12025550123',
    }));

    const turnRequest = {
      groupFolder: 'main',
      channel: 'telegram' as const,
      chatJid: 'tg:main',
      group: mainGroup,
      rawText:
        'Have BlueBubbles send Avery Example a message saying The package arrived, and make it funny.',
      inboundMessageId: 'tg:exact-production-turn',
      now: new Date('2026-07-16T12:00:00.000Z'),
      blueBubblesChannel: {
        getControlSnapshot: () => stale,
        refreshControlState,
      },
      resolveConfig: testConfig,
      resolveLiveRecipient,
      resolveStoredRecipient,
      executionDeps: {
        groupFolder: 'main',
        channel: 'telegram' as const,
        chatJid: 'tg:main',
        currentTime: new Date('2026-07-16T12:00:00.000Z'),
        sendToTarget,
      },
    };
    const result = await executeBlueBubblesOutboundTurn(turnRequest);

    expect(refreshControlState).toHaveBeenCalledWith('transport');
    expect(resolveLiveRecipient).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: 'http://bluebubbles.test' }),
      'Avery Example',
    );
    expect(resolveStoredRecipient).toHaveBeenCalledWith('Avery Example');
    expect(sendToTarget).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      handled: true,
      state: 'staged',
      action: {
        draftText: 'The package arrived',
        sendStatus: 'drafted',
        requiresApproval: true,
      },
    });
    if (!result.handled || result.state !== 'staged') {
      throw new Error('expected approval-gated transformed draft');
    }
    expect(result.presentation.text).toContain('Target: Avery Example');
    expect(result.presentation.text).toContain('The package arrived');
    expect(refreshControlState).toHaveBeenCalledTimes(1);
    expect(resolveStoredRecipient).toHaveBeenCalledTimes(1);
    expect(resolveLiveRecipient).toHaveBeenCalledTimes(1);
    expect(sendToTarget).not.toHaveBeenCalled();
  });

  it('invalidates cached healthy state when the explicit transport refresh fails', async () => {
    const resolveLiveRecipient = vi.fn();
    const sendToTarget = vi.fn();
    const result = await executeBlueBubblesOutboundTurn({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:main',
      group: mainGroup,
      rawText: 'Text Avery Example: Hello.',
      inboundMessageId: 'tg:refresh-failed',
      blueBubblesChannel: {
        getControlSnapshot: () => controlSnapshot(),
        refreshControlState: async () => {
          throw new Error('probe failed');
        },
      },
      resolveConfig: testConfig,
      resolveLiveRecipient,
      executionDeps: {
        groupFolder: 'main',
        channel: 'telegram',
        chatJid: 'tg:main',
        sendToTarget,
      },
    });

    expect(result).toMatchObject({ handled: true, state: 'missing_target' });
    expect(resolveLiveRecipient).not.toHaveBeenCalled();
    expect(sendToTarget).not.toHaveBeenCalled();
  });

  it('blocks execution when live contact validation fails instead of retaining a stale stored GUID', async () => {
    const resolveStoredRecipient = vi.fn(() => ({
      state: 'resolved' as const,
      target: {
        chatJid: 'bb:stale-guid',
        displayName: 'Avery Example',
        isGroup: false,
      },
    }));
    const sendToTarget = vi.fn();
    const result = await executeBlueBubblesOutboundTurn({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:main',
      group: mainGroup,
      rawText: 'Text Avery Example: Hello.',
      inboundMessageId: 'tg:directory-outage',
      blueBubblesChannel: {
        getControlSnapshot: () => controlSnapshot(),
        refreshControlState: async () => controlSnapshot(),
      },
      resolveConfig: testConfig,
      resolveStoredRecipient,
      resolveLiveRecipient: async () => {
        throw new Error('directory unavailable');
      },
      executionDeps: {
        groupFolder: 'main',
        channel: 'telegram',
        chatJid: 'tg:main',
        sendToTarget,
      },
    });

    expect(result).toMatchObject({ handled: true, state: 'missing_target' });
    expect(resolveStoredRecipient).toHaveBeenCalledWith('Avery Example');
    expect(sendToTarget).not.toHaveBeenCalled();
  });

  it('uses an exact stored one-to-one conversation after a successful live directory miss', async () => {
    const resolveStoredRecipient = vi.fn(() => ({
      state: 'resolved' as const,
      target: {
        chatJid: 'bb:iMessage;-;+12025550123',
        displayName: 'Avery Example',
        isGroup: false,
      },
    }));
    const resolveLiveRecipient = vi.fn(async () => ({
      state: 'missing' as const,
    }));
    const sendToTarget = vi.fn<MessageActionExecutionDeps['sendToTarget']>(
      async () => ({
        platformMessageId: 'bb:existing-thread-receipt',
      }),
    );
    const result = await executeBlueBubblesOutboundTurn({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:main',
      group: mainGroup,
      rawText: 'Text Avery Example: Hello.',
      inboundMessageId: 'tg:existing-non-contact',
      blueBubblesChannel: {
        getControlSnapshot: () => controlSnapshot(),
        refreshControlState: async () => controlSnapshot(),
      },
      resolveConfig: testConfig,
      resolveStoredRecipient,
      resolveLiveRecipient,
      executionDeps: {
        groupFolder: 'main',
        channel: 'telegram',
        chatJid: 'tg:main',
        sendToTarget,
      },
    });

    expect(result).toMatchObject({
      handled: true,
      state: 'staged',
      action: { sendStatus: 'drafted', requiresApproval: true },
    });
    expect(resolveStoredRecipient).toHaveBeenCalledWith('Avery Example');
    expect(resolveLiveRecipient).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: 'http://bluebubbles.test' }),
      'Avery Example',
    );
    expect(sendToTarget).not.toHaveBeenCalled();
    if (!result.handled || result.state !== 'staged') {
      throw new Error('expected an approval-gated stored-thread draft');
    }
    expect(JSON.parse(result.action.targetConversationJson)).toMatchObject({
      chatJid: 'bb:iMessage;-;+12025550123',
    });
  });

  it('keeps the exact stored thread when live contact truth confirms the same direct address', async () => {
    const resolveStoredRecipient = vi.fn(() => ({
      state: 'resolved' as const,
      target: {
        chatJid: 'bb:SMS;-;202-555-0123',
        displayName: 'Avery Example',
        isGroup: false,
      },
    }));
    const resolveLiveRecipient = vi.fn(async () => ({
      state: 'resolved' as const,
      target: {
        chatJid: 'bb:iMessage;-;+12025550123',
        displayName: 'Avery Example at +1 202 555 0123',
        isGroup: false as const,
        blueBubblesCreateChatAddress: '+12025550123',
      },
    }));
    const sendToTarget = vi.fn<MessageActionExecutionDeps['sendToTarget']>(
      async () => ({ platformMessageId: 'bb:confirmed-existing-receipt' }),
    );
    const result = await executeBlueBubblesOutboundTurn({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:main',
      group: mainGroup,
      rawText: 'Text Avery Example: Hello.',
      inboundMessageId: 'tg:stored-live-same-identity',
      blueBubblesChannel: {
        getControlSnapshot: () => controlSnapshot(),
        refreshControlState: async () => controlSnapshot(),
      },
      resolveConfig: testConfig,
      resolveStoredRecipient,
      resolveLiveRecipient,
      executionDeps: {
        groupFolder: 'main',
        channel: 'telegram',
        chatJid: 'tg:main',
        sendToTarget,
      },
    });

    expect(result).toMatchObject({
      handled: true,
      state: 'staged',
      action: { sendStatus: 'drafted', requiresApproval: true },
    });
    expect(sendToTarget).not.toHaveBeenCalled();
    if (!result.handled || result.state !== 'staged') {
      throw new Error('expected an approval-gated same-address draft');
    }
    expect(JSON.parse(result.action.targetConversationJson)).toMatchObject({
      chatJid: 'bb:SMS;-;202-555-0123',
    });
  });

  it('reports a missing target when neither stored conversations nor the live directory resolve exactly', async () => {
    const resolveStoredRecipient = vi.fn(() => ({ state: 'missing' as const }));
    const resolveLiveRecipient = vi.fn(async () => ({
      state: 'missing' as const,
    }));
    const sendToTarget = vi.fn();
    const result = await executeBlueBubblesOutboundTurn({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:main',
      group: mainGroup,
      rawText: 'Text Nobody Here: Hello.',
      inboundMessageId: 'tg:missing-everywhere',
      blueBubblesChannel: {
        getControlSnapshot: () => controlSnapshot(),
        refreshControlState: async () => controlSnapshot(),
      },
      resolveConfig: testConfig,
      resolveStoredRecipient,
      resolveLiveRecipient,
      executionDeps: {
        groupFolder: 'main',
        channel: 'telegram',
        chatJid: 'tg:main',
        sendToTarget,
      },
    });

    expect(result).toMatchObject({ handled: true, state: 'missing_target' });
    expect(resolveStoredRecipient).toHaveBeenCalledWith('Nobody Here');
    expect(resolveLiveRecipient).toHaveBeenCalledWith(
      expect.any(Object),
      'Nobody Here',
    );
    expect(sendToTarget).not.toHaveBeenCalled();
  });

  it('re-prompts one fuzzy recipient with the exact body, then stages only after a fresh exact request', async () => {
    const body = 'Dinner is ready: bring salsa 🫶🏽.';
    const target = {
      chatJid: 'bb:iMessage;-;+12025550124',
      displayName: 'Travis Work',
      isGroup: false as const,
    };
    const resolveStoredRecipient = vi.fn((query: string) =>
      query === 'Travis'
        ? { state: 'ambiguous' as const, matches: [target] }
        : { state: 'resolved' as const, target },
    );
    const resolveLiveRecipient = vi.fn(async () => ({
      state: 'missing' as const,
    }));
    const refreshControlState = vi.fn(async () => controlSnapshot());
    const sendToTarget = vi.fn();
    const common = {
      groupFolder: 'main',
      channel: 'telegram' as const,
      chatJid: 'tg:main',
      group: mainGroup,
      blueBubblesChannel: {
        getControlSnapshot: () => controlSnapshot(),
        refreshControlState,
      },
      resolveConfig: testConfig,
      resolveStoredRecipient,
      resolveLiveRecipient,
      executionDeps: {
        groupFolder: 'main',
        channel: 'telegram' as const,
        chatJid: 'tg:main',
        sendToTarget,
      },
    };

    const fuzzy = await executeBlueBubblesOutboundTurn({
      ...common,
      rawText: `Text Travis: ${body}`,
      inboundMessageId: 'tg:one-fuzzy-recipient',
    });

    expect(fuzzy).toMatchObject({
      handled: true,
      state: 'ambiguous_target',
    });
    if (!fuzzy.handled || fuzzy.state !== 'ambiguous_target') {
      throw new Error('expected a fuzzy recipient re-prompt');
    }
    expect(fuzzy.replyText).toContain('one possible Messages recipient');
    expect(fuzzy.replyText).not.toContain('more than one');
    expect(fuzzy.replyText).toContain(`Text Travis Work: ${body}`);
    expect(fuzzy.replyText).toContain('separate fresh');
    expect(resolveLiveRecipient).not.toHaveBeenCalled();
    expect(sendToTarget).not.toHaveBeenCalled();
    expect(listMessageActionsForGroup({ groupFolder: 'main' })).toHaveLength(0);

    const exact = await executeBlueBubblesOutboundTurn({
      ...common,
      rawText: `Text Travis Work: ${body}`,
      inboundMessageId: 'tg:exact-recipient-after-fuzzy',
    });

    expect(exact).toMatchObject({
      handled: true,
      state: 'staged',
      action: {
        draftText: body,
        sendStatus: 'drafted',
        requiresApproval: true,
        platformMessageId: null,
      },
    });
    expect(resolveLiveRecipient).toHaveBeenCalledWith(
      expect.any(Object),
      'Travis Work',
    );
    expect(sendToTarget).not.toHaveBeenCalled();
    expect(listMessageActionsForGroup({ groupFolder: 'main' })).toHaveLength(1);
  });

  it('rejects stored ambiguity without allowing a same-name live contact to redirect the request', async () => {
    const resolveStoredRecipient = vi.fn(() => ({
      state: 'ambiguous' as const,
      matches: [
        {
          chatJid: 'bb:iMessage;-;+12025550123',
          displayName: 'Avery Example at +1 202 555 0123',
          isGroup: false,
        },
        {
          chatJid: 'bb:iMessage;-;+13125550123',
          displayName: 'Avery Example at +1 312 555 0123',
          isGroup: false,
        },
      ],
    }));
    const resolveLiveRecipient = vi.fn(async () => ({
      state: 'resolved' as const,
      target: {
        chatJid: 'bb:iMessage;-;+12025550123',
        displayName: 'Avery Example',
        isGroup: false as const,
        blueBubblesCreateChatAddress: '+12025550123',
      },
    }));
    const sendToTarget = vi.fn();
    const result = await executeBlueBubblesOutboundTurn({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:main',
      group: mainGroup,
      rawText: 'Text Avery Example: Hello.',
      inboundMessageId: 'tg:stored-ambiguous',
      blueBubblesChannel: {
        getControlSnapshot: () => controlSnapshot(),
        refreshControlState: async () => controlSnapshot(),
      },
      resolveConfig: testConfig,
      resolveStoredRecipient,
      resolveLiveRecipient,
      executionDeps: {
        groupFolder: 'main',
        channel: 'telegram',
        chatJid: 'tg:main',
        sendToTarget,
      },
    });

    expect(result).toMatchObject({ handled: true, state: 'ambiguous_target' });
    expect(resolveStoredRecipient).toHaveBeenCalledWith('Avery Example');
    expect(resolveLiveRecipient).not.toHaveBeenCalled();
    expect(sendToTarget).not.toHaveBeenCalled();
  });

  it('rejects live ambiguity when no stored conversation resolves exactly', async () => {
    const resolveStoredRecipient = vi.fn(() => ({ state: 'missing' as const }));
    const resolveLiveRecipient = vi.fn(async () => ({
      state: 'ambiguous' as const,
      matches: [
        {
          chatJid: 'bb:iMessage;-;+12025550123',
          displayName: 'Avery Example at +1 202 555 0123',
          isGroup: false as const,
          blueBubblesCreateChatAddress: '+12025550123',
        },
        {
          chatJid: 'bb:iMessage;-;+13125550123',
          displayName: 'Avery Example at +1 312 555 0123',
          isGroup: false as const,
          blueBubblesCreateChatAddress: '+13125550123',
        },
      ],
    }));
    const sendToTarget = vi.fn();
    const result = await executeBlueBubblesOutboundTurn({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:main',
      group: mainGroup,
      rawText: 'Text Avery Example: Hello.',
      inboundMessageId: 'tg:live-ambiguous',
      blueBubblesChannel: {
        getControlSnapshot: () => controlSnapshot(),
        refreshControlState: async () => controlSnapshot(),
      },
      resolveConfig: testConfig,
      resolveStoredRecipient,
      resolveLiveRecipient,
      executionDeps: {
        groupFolder: 'main',
        channel: 'telegram',
        chatJid: 'tg:main',
        sendToTarget,
      },
    });

    expect(result).toMatchObject({ handled: true, state: 'ambiguous_target' });
    expect(resolveStoredRecipient).toHaveBeenCalledWith('Avery Example');
    expect(resolveLiveRecipient).toHaveBeenCalledTimes(1);
    expect(sendToTarget).not.toHaveBeenCalled();
  });

  it('rejects an authoritative stored group without allowing a same-name contact redirect', async () => {
    const resolveStoredRecipient = vi.fn(() => ({
      state: 'resolved' as const,
      target: {
        chatJid: 'bb:iMessage;+;family-group',
        displayName: 'Family',
        isGroup: true,
      },
    }));
    const resolveLiveRecipient = vi.fn(async () => ({
      state: 'resolved' as const,
      target: {
        chatJid: 'bb:iMessage;-;+12025550123',
        displayName: 'Family',
        isGroup: false as const,
        blueBubblesCreateChatAddress: '+12025550123',
      },
    }));
    const sendToTarget = vi.fn();
    const result = await executeBlueBubblesOutboundTurn({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:main',
      group: mainGroup,
      rawText: 'Text Family: Dinner is ready.',
      inboundMessageId: 'tg:stored-group',
      blueBubblesChannel: {
        getControlSnapshot: () => controlSnapshot(),
        refreshControlState: async () => controlSnapshot(),
      },
      resolveConfig: testConfig,
      resolveStoredRecipient,
      resolveLiveRecipient,
      executionDeps: {
        groupFolder: 'main',
        channel: 'telegram',
        chatJid: 'tg:main',
        sendToTarget,
      },
    });

    expect(result).toMatchObject({
      handled: true,
      state: 'unsupported_target',
    });
    expect(resolveStoredRecipient).toHaveBeenCalledWith('Family');
    expect(resolveLiveRecipient).not.toHaveBeenCalled();
    expect(sendToTarget).not.toHaveBeenCalled();
  });

  it('rejects conflicting exact stored and live identities instead of choosing either recipient', async () => {
    const resolveStoredRecipient = vi.fn(() => ({
      state: 'resolved' as const,
      target: {
        chatJid: 'bb:iMessage;-;+12025550123',
        displayName: 'Avery Example',
        isGroup: false,
      },
    }));
    const resolveLiveRecipient = vi.fn(async () => ({
      state: 'resolved' as const,
      target: {
        chatJid: 'bb:iMessage;-;+13125550123',
        displayName: 'Avery Example at +1 312 555 0123',
        isGroup: false as const,
        blueBubblesCreateChatAddress: '+13125550123',
      },
    }));
    const sendToTarget = vi.fn();
    const result = await executeBlueBubblesOutboundTurn({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:main',
      group: mainGroup,
      rawText: 'Text Avery Example: Hello.',
      inboundMessageId: 'tg:identity-conflict',
      blueBubblesChannel: {
        getControlSnapshot: () => controlSnapshot(),
        refreshControlState: async () => controlSnapshot(),
      },
      resolveConfig: testConfig,
      resolveStoredRecipient,
      resolveLiveRecipient,
      executionDeps: {
        groupFolder: 'main',
        channel: 'telegram',
        chatJid: 'tg:main',
        sendToTarget,
      },
    });

    expect(result).toMatchObject({ handled: true, state: 'ambiguous_target' });
    if (!result.handled || result.state !== 'ambiguous_target') {
      throw new Error('expected conflicting recipients to remain ambiguous');
    }
    expect(result.replyText).toContain('+1 312 555 0123');
    expect(resolveStoredRecipient).toHaveBeenCalledWith('Avery Example');
    expect(resolveLiveRecipient).toHaveBeenCalledTimes(1);
    expect(sendToTarget).not.toHaveBeenCalled();
  });

  it('keeps draft wording non-executing and does not require an execute-time refresh', async () => {
    const refreshControlState = vi.fn();
    const sendToTarget = vi.fn();
    const result = await executeBlueBubblesOutboundTurn({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:main',
      group: mainGroup,
      rawText: 'Draft a text to Avery Example: Hello.',
      inboundMessageId: 'tg:draft-production-turn',
      blueBubblesChannel: {
        getControlSnapshot: () => controlSnapshot(),
        refreshControlState,
      },
      resolveConfig: testConfig,
      resolveLiveRecipient: async () => ({ state: 'missing' }),
      resolveStoredRecipient: () => ({
        state: 'resolved',
        target: {
          chatJid: 'bb:iMessage;-;+12025550123',
          displayName: 'Avery Example',
          isGroup: false,
        },
      }),
      executionDeps: {
        groupFolder: 'main',
        channel: 'telegram',
        chatJid: 'tg:main',
        sendToTarget,
      },
    });

    expect(result).toMatchObject({ handled: true, state: 'staged' });
    expect(refreshControlState).not.toHaveBeenCalled();
    expect(sendToTarget).not.toHaveBeenCalled();
  });

  it('reports unavailable when the descriptor exists but its executable binding does not', async () => {
    const descriptorOnlyRegistry = new RuntimeCapabilityRegistry(
      DEFAULT_RUNTIME_CAPABILITY_DESCRIPTORS,
    );
    const sendToTarget = vi.fn();
    const result = await executeBlueBubblesOutboundTurn({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:main',
      group: mainGroup,
      rawText: 'Text Avery Example: Hello.',
      inboundMessageId: 'tg:unbound-tool',
      registry: descriptorOnlyRegistry,
      blueBubblesChannel: {
        getControlSnapshot: () => controlSnapshot(),
        refreshControlState: async () => controlSnapshot(),
      },
      resolveConfig: testConfig,
      executionDeps: {
        groupFolder: 'main',
        channel: 'telegram',
        chatJid: 'tg:main',
        sendToTarget,
      },
    });

    expect(result).toMatchObject({
      handled: true,
      state: 'unavailable_capability',
    });
    expect(sendToTarget).not.toHaveBeenCalled();
  });
});
