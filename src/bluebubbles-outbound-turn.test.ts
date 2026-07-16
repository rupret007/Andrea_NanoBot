import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import './channels/index.js';

import { executeBlueBubblesOutboundTurn } from './bluebubbles-outbound-turn.js';
import { resolveBlueBubblesConfig } from './channels/bluebubbles.js';
import { _closeDatabase, _initTestDatabase } from './db.js';
import type { MessageActionExecutionDeps } from './message-actions.js';
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
          displayName: 'Travis Story',
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
        rawText: 'Text Travis Story: Dinner is ready.',
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
      rawText:
        'Yes reply to 1 Candace saying yes I need her to pick up please.',
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
          displayName: 'Candace Story',
          isGroup: false,
        },
      },
    }));
    const refreshControlState = vi.fn(async () => controlSnapshot());
    const sendToTarget = vi.fn(async () => ({
      platformMessageId: 'bb:candace-numbered-receipt',
    }));
    const turnRequest = {
      groupFolder: 'main',
      channel: 'telegram' as const,
      chatJid: 'tg:main',
      group: mainGroup,
      rawText:
        'Yes reply to 1 Candace saying yes I need her to pick up please.',
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
    expect(result).toMatchObject({ handled: true, state: 'sent' });
    expect(sendToTarget).toHaveBeenCalledWith(
      'bluebubbles',
      'bb:iMessage;-;+18176580310',
      'Yes, please pick them up.',
      expect.objectContaining({ idempotencyKey: expect.any(String) }),
    );

    resolveContextBoundRecipient.mockRejectedValueOnce(
      new Error('review seed is now stale'),
    );
    const replay = await executeBlueBubblesOutboundTurn(turnRequest);
    expect(replay).toMatchObject({
      handled: true,
      state: 'sent',
      action: { platformMessageId: 'bb:candace-numbered-receipt' },
    });
    expect(resolveContextBoundRecipient).toHaveBeenCalledTimes(1);
    expect(refreshControlState).toHaveBeenCalledTimes(1);
    expect(sendToTarget).toHaveBeenCalledTimes(1);
  });

  it('dispatches the real recent-Candace composite only through a context-bound recipient', async () => {
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
            displayName: 'Candace Story',
            isGroup: false,
          },
        },
      };
    });
    const sendToTarget = vi.fn(async () => ({
      platformMessageId: 'bb:candace-composite-receipt',
    }));

    const result = await executeBlueBubblesOutboundTurn({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:main',
      group: mainGroup,
      rawText:
        "Hi can you use blue bubbles to send a message back to Candace please. Check my recent text from her and reply from you that yes please if she could pick them up I haven't had a chance.",
      inboundMessageId: 'tg-candace-composite',
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

    expect(result).toMatchObject({ handled: true, state: 'sent' });
    expect(resolveContextBoundRecipient).toHaveBeenCalledTimes(1);
    expect(sendToTarget).toHaveBeenCalledWith(
      'bluebubbles',
      'bb:iMessage;-;+18176580310',
      'Yes, please pick them up. I haven’t had a chance.',
      expect.objectContaining({ idempotencyKey: expect.any(String) }),
    );
  });

  it('allows an owner-authored configured BlueBubbles self-thread turn through offline provider spies', async () => {
    const refreshControlState = vi.fn(async () => controlSnapshot());
    const resolveStoredRecipient = vi.fn(() => ({
      state: 'resolved' as const,
      target: {
        chatJid: 'bb:iMessage;-;+12025550123',
        displayName: 'Travis Story',
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
      rawText: 'Text Travis Story: Dinner is ready.',
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

    expect(result).toMatchObject({ handled: true, state: 'sent' });
    expect(refreshControlState).toHaveBeenCalledWith('transport');
    expect(sendToTarget).toHaveBeenCalledTimes(1);
  });

  it('drives the exact prompt through fresh health, exact live identity, the registered binding, and a verified receipt', async () => {
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
        displayName: 'Travis Story',
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
        'Have BlueBubbles send Travis Story a message saying hi from Andrea and he smells, and make it funny.',
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
      'Travis Story',
    );
    expect(resolveStoredRecipient).toHaveBeenCalledWith('Travis Story');
    expect(sendToTarget).toHaveBeenCalledTimes(1);
    expect(sendToTarget).toHaveBeenCalledWith(
      'bluebubbles',
      'bb:iMessage;-;+12025550123',
      'Hi from Andrea — she says you smell, but in a limited-edition, artisanal way. 😄',
      expect.objectContaining({
        blueBubblesCreateChatAddress: '+12025550123',
        idempotencyKey: expect.any(String),
      }),
    );
    expect(result).toMatchObject({ handled: true, state: 'sent' });
    if (!result.handled || result.state !== 'sent') {
      throw new Error('expected verified send');
    }
    expect(result.replyText).toContain('Sent to Travis Story');
    expect(result.replyText).toContain('bb:provider-receipt-1');
    expect(result.replyText).toContain(
      'Hi from Andrea — she says you smell, but in a limited-edition, artisanal way. 😄',
    );

    refreshControlState.mockRejectedValueOnce(new Error('provider now down'));
    resolveLiveRecipient.mockRejectedValueOnce(new Error('directory now down'));
    const replay = await executeBlueBubblesOutboundTurn(turnRequest);
    expect(replay).toMatchObject({
      handled: true,
      state: 'sent',
      action: { platformMessageId: 'bb:provider-receipt-1' },
    });
    expect(replay.handled && replay.state === 'sent' && replay.replyText).toBe(
      result.replyText,
    );
    expect(refreshControlState).toHaveBeenCalledTimes(1);
    expect(resolveStoredRecipient).toHaveBeenCalledTimes(1);
    expect(resolveLiveRecipient).toHaveBeenCalledTimes(1);
    expect(sendToTarget).toHaveBeenCalledTimes(1);
  });

  it('invalidates cached healthy state when the explicit transport refresh fails', async () => {
    const resolveLiveRecipient = vi.fn();
    const sendToTarget = vi.fn();
    const result = await executeBlueBubblesOutboundTurn({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:main',
      group: mainGroup,
      rawText: 'Text Travis Story: Hello.',
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

    expect(result).toMatchObject({
      handled: true,
      state: 'unhealthy_provider',
    });
    expect(resolveLiveRecipient).not.toHaveBeenCalled();
    expect(sendToTarget).not.toHaveBeenCalled();
  });

  it('blocks execution when live contact validation fails instead of retaining a stale stored GUID', async () => {
    const resolveStoredRecipient = vi.fn(() => ({
      state: 'resolved' as const,
      target: {
        chatJid: 'bb:stale-guid',
        displayName: 'Travis Story',
        isGroup: false,
      },
    }));
    const sendToTarget = vi.fn();
    const result = await executeBlueBubblesOutboundTurn({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:main',
      group: mainGroup,
      rawText: 'Text Travis Story: Hello.',
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
    expect(resolveStoredRecipient).toHaveBeenCalledWith('Travis Story');
    expect(sendToTarget).not.toHaveBeenCalled();
  });

  it('uses an exact stored one-to-one conversation after a successful live directory miss', async () => {
    const resolveStoredRecipient = vi.fn(() => ({
      state: 'resolved' as const,
      target: {
        chatJid: 'bb:iMessage;-;+12025550123',
        displayName: 'Travis Story',
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
      rawText: 'Text Travis Story: Hello.',
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

    expect(result).toMatchObject({ handled: true, state: 'sent' });
    expect(resolveStoredRecipient).toHaveBeenCalledWith('Travis Story');
    expect(resolveLiveRecipient).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: 'http://bluebubbles.test' }),
      'Travis Story',
    );
    expect(sendToTarget).toHaveBeenCalledTimes(1);
    expect(sendToTarget).toHaveBeenCalledWith(
      'bluebubbles',
      'bb:iMessage;-;+12025550123',
      'Hello.',
      expect.objectContaining({ idempotencyKey: expect.any(String) }),
    );
    expect(
      sendToTarget.mock.calls[0]?.[3]?.blueBubblesCreateChatAddress,
    ).toBeUndefined();
  });

  it('keeps the exact stored thread when live contact truth confirms the same direct address', async () => {
    const resolveStoredRecipient = vi.fn(() => ({
      state: 'resolved' as const,
      target: {
        chatJid: 'bb:SMS;-;202-555-0123',
        displayName: 'Travis Story',
        isGroup: false,
      },
    }));
    const resolveLiveRecipient = vi.fn(async () => ({
      state: 'resolved' as const,
      target: {
        chatJid: 'bb:iMessage;-;+12025550123',
        displayName: 'Travis Story at +1 202 555 0123',
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
      rawText: 'Text Travis Story: Hello.',
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

    expect(result).toMatchObject({ handled: true, state: 'sent' });
    expect(sendToTarget).toHaveBeenCalledWith(
      'bluebubbles',
      'bb:SMS;-;202-555-0123',
      'Hello.',
      expect.objectContaining({ idempotencyKey: expect.any(String) }),
    );
    expect(
      sendToTarget.mock.calls[0]?.[3]?.blueBubblesCreateChatAddress,
    ).toBeUndefined();
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

  it('rejects stored ambiguity without allowing a same-name live contact to redirect the request', async () => {
    const resolveStoredRecipient = vi.fn(() => ({
      state: 'ambiguous' as const,
      matches: [
        {
          chatJid: 'bb:iMessage;-;+12025550123',
          displayName: 'Travis Story at +1 202 555 0123',
          isGroup: false,
        },
        {
          chatJid: 'bb:iMessage;-;+13125550123',
          displayName: 'Travis Story at +1 312 555 0123',
          isGroup: false,
        },
      ],
    }));
    const resolveLiveRecipient = vi.fn(async () => ({
      state: 'resolved' as const,
      target: {
        chatJid: 'bb:iMessage;-;+12025550123',
        displayName: 'Travis Story',
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
      rawText: 'Text Travis Story: Hello.',
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
    expect(resolveStoredRecipient).toHaveBeenCalledWith('Travis Story');
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
          displayName: 'Travis Story at +1 202 555 0123',
          isGroup: false as const,
          blueBubblesCreateChatAddress: '+12025550123',
        },
        {
          chatJid: 'bb:iMessage;-;+13125550123',
          displayName: 'Travis Story at +1 312 555 0123',
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
      rawText: 'Text Travis Story: Hello.',
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
    expect(resolveStoredRecipient).toHaveBeenCalledWith('Travis Story');
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
        displayName: 'Travis Story',
        isGroup: false,
      },
    }));
    const resolveLiveRecipient = vi.fn(async () => ({
      state: 'resolved' as const,
      target: {
        chatJid: 'bb:iMessage;-;+13125550123',
        displayName: 'Travis Story at +1 312 555 0123',
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
      rawText: 'Text Travis Story: Hello.',
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
    expect(resolveStoredRecipient).toHaveBeenCalledWith('Travis Story');
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
      rawText: 'Draft a text to Travis Story: Hello.',
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
          displayName: 'Travis Story',
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
      rawText: 'Text Travis Story: Hello.',
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
