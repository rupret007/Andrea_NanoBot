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
  getMessageAction,
  listMessageActionsForGroup,
  storeChatMetadata,
  updateMessageAction,
} from './db.js';
import { applyMessageActionOperation } from './message-actions.js';
import { runtimeCapabilityRegistry } from './runtime-capability-registry.js';
import { registerProductionRuntimeCapabilitySurfaces } from './runtime-capability-production-surfaces.js';
import {
  isNeverAuthorizeSendCaller,
  isNeverAuthorizeSendSurface,
  isTrustedOwnerReviewSurface,
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
    expect(resolveBlueBubblesSendMethod('private-api')).toBe('apple-script');
    expect(resolveBlueBubblesSendMethod('private_api')).toBe('apple-script');
  });

  it('refuses QA, Karen, and ordinary callers as send authorizers', () => {
    for (const chatJid of ['tg:qa', 'tg:karen', 'tg:andrea-qa']) {
      expect(
        isNeverAuthorizeSendCaller({ group: mainGroup, chatJid }),
      ).toBe(true);
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

    for (const chatJid of ['tg:qa', 'tg:karen']) {
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

    expect(sendToTarget).not.toHaveBeenCalled();
    expect(getMessageAction(staged.action.messageActionId)?.sendStatus).toBe(
      'drafted',
    );
  });
});
