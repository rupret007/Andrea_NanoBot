import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import './channels/index.js';

import {
  _closeDatabase,
  _initTestDatabase,
  getMessageAction,
  listMessageActionsForGroup,
  storeChatMetadata,
  storeMessageDirect,
  upsertDelegationRule,
  updateMessageAction,
} from './db.js';
import {
  executeBlueBubblesOutboundRequest,
  stageBlueBubblesOutboundRequest,
  type BlueBubblesOutboundRequestResult,
  type ExecuteBlueBubblesOutboundRequestParams,
  type ExecuteBlueBubblesOutboundRequestResult,
} from './bluebubbles-outbound-request.js';
import {
  ChannelDeliveryRejectedBeforeDispatchError,
  ChannelDeliveryUnverifiedError,
} from './channel-delivery.js';
import {
  setMessagingOutboundPaused,
  validateMessagingOutboundAuthorizationFence,
} from './messaging-outbound-pause.js';
import {
  applyMessageActionOperation,
  createOrRefreshMessageActionFromDraft,
  reconcileBlueBubblesUnverifiedMessageActions,
  resolveBlueBubblesThreadTargetByName,
} from './message-actions.js';
import {
  runtimeCapabilityRegistry,
  type RuntimeCapabilityFacts,
} from './runtime-capability-registry.js';
import { registerProductionRuntimeCapabilitySurfaces } from './runtime-capability-production-surfaces.js';
import type {
  DelegationRuleRecord,
  RegisteredGroup,
  SendMessageOptions,
} from './types.js';

registerProductionRuntimeCapabilitySurfaces(runtimeCapabilityRegistry);

const mainGroup: RegisteredGroup = {
  name: 'Main',
  folder: 'main',
  trigger: '@Andrea',
  added_at: '2026-07-15T00:00:00.000Z',
  requiresTrigger: false,
  isMain: true,
};

const companionGroup: RegisteredGroup = {
  ...mainGroup,
  name: 'BlueBubbles (Main)',
  isMain: false,
};

const readyCapabilityFacts: RuntimeCapabilityFacts = {
  toolRegistered: true,
  toolExposed: true,
  providerHealth: 'healthy',
  writePermission: 'granted',
  confirmation: 'satisfied',
};

function seedRecipient(
  name = 'Avery Example',
  jid = 'bb:iMessage;-;+12025550123',
  isGroup = false,
) {
  storeChatMetadata(
    jid,
    '2026-07-15T18:00:00.000Z',
    name,
    'bluebubbles',
    isGroup,
  );
}

function requireStaged(
  result: BlueBubblesOutboundRequestResult,
): Extract<BlueBubblesOutboundRequestResult, { state: 'staged' }> {
  if (!result.handled || result.state !== 'staged') {
    throw new Error('expected staged result');
  }
  return result;
}

async function stageThenApproveBlueBubblesOutboundRequest(
  params: ExecuteBlueBubblesOutboundRequestParams,
): Promise<ExecuteBlueBubblesOutboundRequestResult> {
  const initial = await executeBlueBubblesOutboundRequest(params);
  if (!initial.handled || initial.state !== 'staged') return initial;

  const approvalAt =
    params.executionDeps.currentTime || params.now || new Date();
  updateMessageAction(initial.action.messageActionId, {
    presentationMessageId: `test-card:${initial.action.messageActionId}`,
    lastUpdatedAt: approvalAt.toISOString(),
  });
  const approved = await applyMessageActionOperation(
    initial.action.messageActionId,
    { kind: 'send' },
    params.executionDeps,
  );
  if (!approved.action) {
    throw new Error('expected separately approved message action');
  }
  const state =
    approved.action.sendStatus === 'sent'
      ? 'sent'
      : approved.action.sendStatus === 'delivery_unverified'
        ? 'delivery_unverified'
        : 'execution_failure';
  return {
    handled: true,
    state,
    action: approved.action,
    replyText: approved.replyText || '',
  };
}

describe('BlueBubbles outbound requests', () => {
  const originalDisable = process.env.ANDREA_TEST_DISABLE_OWNER_ENV_FILE;
  const originalCanonical = process.env.BLUEBUBBLES_CANONICAL_SELF_THREAD_JID;
  const originalAliases = process.env.BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS;

  beforeEach(() => {
    _initTestDatabase();
    process.env.ANDREA_TEST_DISABLE_OWNER_ENV_FILE = '1';
    process.env.BLUEBUBBLES_CANONICAL_SELF_THREAD_JID =
      'iMessage;-;owner@example.invalid';
    process.env.BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS = 'SMS;-;+12025550109';
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
    if (originalAliases == null) {
      delete process.env.BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS;
    } else {
      process.env.BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS = originalAliases;
    }
  });

  it('registers the executable host tool declared by the capability registry', () => {
    expect(
      runtimeCapabilityRegistry.getToolBinding('messages.send.bluebubbles'),
    ).toMatchObject({ toolId: 'host.messages.send.bluebubbles' });
  });

  it('stages a named BlueBubbles text from the registered main Telegram chat', () => {
    seedRecipient();

    const result = stageBlueBubblesOutboundRequest({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:main',
      group: mainGroup,
      rawText:
        "Send a text message to Avery Example saying dinner's ready and let him know it's Andrea",
      inboundMessageId: 'tg-message-101',
      now: new Date('2026-07-15T18:05:00.000Z'),
    });

    const staged = requireStaged(result);
    expect(staged.action).toMatchObject({
      targetChannel: 'bluebubbles',
      targetKind: 'external_thread',
      presentationChatJid: 'tg:main',
      draftText: "dinner's ready and let him know it's Andrea",
      sendStatus: 'drafted',
      requiresApproval: true,
      delegationRuleId: null,
    });
    expect(JSON.parse(staged.action.targetConversationJson)).toEqual({
      kind: 'external_thread',
      chatJid: 'bb:iMessage;-;+12025550123',
      threadId: null,
      replyToMessageId: null,
      isGroup: false,
      personName: 'Avery Example',
    });
    expect(staged.presentation.text).toContain(
      'Target: Avery Example in Messages.',
    );
    expect(staged.presentation.text).toContain('waiting for your approval');
    expect(staged.presentation.inlineActionRows.flat()).toEqual([
      expect.objectContaining({ label: 'Send now' }),
      expect.objectContaining({ label: 'Discard draft' }),
    ]);
  });

  it.each([
    'Text Avery Example: Dinner is ready.',
    'Send a text message to Avery Example saying Dinner is ready.',
  ])(
    'keeps a fresh direct imperative unsent until a separate approval: %s',
    async (rawText) => {
      seedRecipient();
      const sendToTarget = vi.fn();
      const result = await executeBlueBubblesOutboundRequest({
        groupFolder: 'main',
        channel: 'telegram',
        chatJid: 'tg:main',
        group: mainGroup,
        rawText,
        inboundMessageId: `tg:initial-card:${rawText.startsWith('Text') ? 'text' : 'send'}`,
        capabilityFacts: readyCapabilityFacts,
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
          draftText: 'Dinner is ready.',
          sendStatus: 'drafted',
          requiresApproval: true,
          platformMessageId: null,
        },
      });
      expect(sendToTarget).not.toHaveBeenCalled();
      if (!result.handled || result.state !== 'staged') {
        throw new Error('expected a recipient-bound approval card');
      }
      expect(result.presentation.text).toContain(
        'Target: Avery Example in Messages.',
      );
      expect(result.presentation.text).toContain(
        'Andrea: I staged your exact text.',
      );
      expect(result.presentation.text).not.toContain(
        'Andrea: I drafted a reply.',
      );
      expect(JSON.parse(result.action.explanationJson || '{}')).toMatchObject({
        draftProvenance: 'owner_literal',
      });
      expect(result.presentation.inlineActionRows.flat()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ label: 'Send now' }),
        ]),
      );
    },
  );

  it('stages a funny authoring request without inventing recipient-facing bytes', async () => {
    seedRecipient();
    const sendToTarget = vi.fn(async () => ({
      platformMessageId: 'bb:avery-funny-receipt',
    }));

    const result = await executeBlueBubblesOutboundRequest({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:main',
      group: mainGroup,
      rawText:
        'Have BlueBubbles send Avery Example a message saying The package arrived, and make it funny.',
      inboundMessageId: 'tg-exact-avery-funny',
      now: new Date('2026-07-16T12:00:00.000Z'),
      capabilityFacts: readyCapabilityFacts,
      executionDeps: {
        groupFolder: 'main',
        channel: 'telegram',
        chatJid: 'tg:main',
        currentTime: new Date('2026-07-16T12:00:00.000Z'),
        sendToTarget,
      },
    });

    expect(result).toMatchObject({ handled: true, state: 'staged' });
    expect(sendToTarget).not.toHaveBeenCalled();
    if (!result.handled || result.state !== 'staged') {
      throw new Error('expected approval-gated transformed draft');
    }
    expect(result.action).toMatchObject({
      draftText: 'The package arrived',
      sendStatus: 'drafted',
      requiresApproval: true,
      platformMessageId: null,
    });
    expect(result.presentation.text).toContain('Target: Avery Example');
    expect(result.presentation.text).toContain('The package arrived');
    expect(result.presentation.text).toContain('waiting for your approval');
  });

  it.each([
    'Reply to #1 saying Line one.\nLine two 🫶🏽.',
    'Reply to #1: Line one.\nLine two 🫶🏽.',
    'Reply to 1 Candace: Line one.\nLine two 🫶🏽.',
  ])(
    'stages an exactly context-bound numbered reply without requiring a redundant recipient label: %s',
    async (rawText) => {
      const sendToTarget = vi.fn(async () => ({
        platformMessageId: 'bb:numbered-context-receipt',
      }));

      const result = await executeBlueBubblesOutboundRequest({
        groupFolder: 'main',
        channel: 'telegram',
        chatJid: 'tg:main',
        group: mainGroup,
        rawText,
        inboundMessageId: `tg-numbered-${rawText.includes('Candace') ? 'named' : rawText.includes('saying') ? 'saying' : 'colon'}`,
        recipientResolution: {
          state: 'resolved',
          target: {
            chatJid: 'bb:iMessage;-;+14695550123',
            displayName: 'Candace',
            isGroup: false,
          },
        },
        now: new Date('2026-07-16T12:00:00.000Z'),
        capabilityFacts: readyCapabilityFacts,
        executionDeps: {
          groupFolder: 'main',
          channel: 'telegram',
          chatJid: 'tg:main',
          currentTime: new Date('2026-07-16T12:00:00.000Z'),
          sendToTarget,
        },
      });

      expect(result).toMatchObject({
        handled: true,
        state: 'staged',
        action: {
          draftText: 'Line one.\nLine two 🫶🏽.',
          sendStatus: 'drafted',
          requiresApproval: true,
        },
      });
      expect(sendToTarget).not.toHaveBeenCalled();
    },
  );

  it('stages a transformed numbered reply against its resolved review recipient', async () => {
    const sendToTarget = vi.fn();
    const result = await executeBlueBubblesOutboundRequest({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:main',
      group: mainGroup,
      rawText: 'Reply to #1: I can bring dinner, and make it warmer.',
      inboundMessageId: 'tg-numbered-warmer',
      recipientResolution: {
        state: 'resolved',
        target: {
          chatJid: 'bb:iMessage;-;+14695550123',
          displayName: 'Candace',
          isGroup: false,
        },
      },
      capabilityFacts: readyCapabilityFacts,
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
        targetKind: 'external_thread',
        sendStatus: 'drafted',
        requiresApproval: true,
      },
    });
    expect(sendToTarget).not.toHaveBeenCalled();
    if (!result.handled || result.state !== 'staged') {
      throw new Error('expected staged context-bound rewrite');
    }
    expect(JSON.parse(result.action.targetConversationJson)).toMatchObject({
      chatJid: 'bb:iMessage;-;+14695550123',
      personName: 'Candace',
    });
    expect(result.presentation.text).toContain('Andrea: I drafted a reply.');
    expect(result.presentation.text).not.toContain(
      'Andrea: I staged your exact text.',
    );
  });

  it('distinguishes a draft request from execution and performs no provider write', async () => {
    seedRecipient();
    const sendToTarget = vi.fn();
    const result = await executeBlueBubblesOutboundRequest({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:main',
      group: mainGroup,
      rawText:
        'Draft a funny message to Avery Example saying The package arrived.',
      inboundMessageId: 'tg-avery-draft-only',
      capabilityFacts: readyCapabilityFacts,
      executionDeps: {
        groupFolder: 'main',
        channel: 'telegram',
        chatJid: 'tg:main',
        sendToTarget,
      },
    });

    expect(result).toMatchObject({ handled: true, state: 'staged' });
    expect(sendToTarget).not.toHaveBeenCalled();
  });

  it('replays the same inbound execution from its verified receipt without sending twice', async () => {
    seedRecipient();
    const sendToTarget = vi.fn(async () => ({
      platformMessageId: 'bb:stable-receipt',
    }));
    const request = {
      groupFolder: 'main',
      channel: 'telegram' as const,
      chatJid: 'tg:main',
      group: mainGroup,
      rawText: 'Text Avery Example: Unicode works 🫶🏽 e\u0301.',
      inboundMessageId: 'tg-stable-inbound',
      capabilityFacts: readyCapabilityFacts,
      executionDeps: {
        groupFolder: 'main',
        channel: 'telegram' as const,
        chatJid: 'tg:main',
        sendToTarget,
      },
    };

    const first = await stageThenApproveBlueBubblesOutboundRequest(request);
    const second = await executeBlueBubblesOutboundRequest(request);

    expect(first).toMatchObject({ handled: true, state: 'sent' });
    expect(second).toMatchObject({ handled: true, state: 'sent' });
    expect(sendToTarget).toHaveBeenCalledTimes(1);
    expect(sendToTarget).toHaveBeenCalledWith(
      'bluebubbles',
      expect.any(String),
      'Unicode works 🫶🏽 e\u0301.',
      expect.any(Object),
    );
  });

  it('grounds a pre-upgrade terminal inbound action without redispatching it', async () => {
    const legacyAction = createOrRefreshMessageActionFromDraft({
      groupFolder: 'main',
      presentationChannel: 'telegram',
      presentationChatJid: 'tg:main',
      sourceType: 'manual_prompt',
      sourceKey: 'outbound-message:telegram:tg:main:legacy-terminal-inbound',
      draftText: 'Legacy terminal body.',
      personName: 'Avery Example',
      forceApproval: true,
      targetOverride: {
        kind: 'external_thread',
        chatJid: 'bb:iMessage;-;+12025550123',
        isGroup: false,
        personName: 'Avery Example',
      },
      targetChannelOverride: 'bluebubbles',
      now: new Date('2026-07-16T10:00:00.000Z'),
    });
    updateMessageAction(legacyAction.messageActionId, {
      sendStatus: 'sent',
      requiresApproval: false,
      approvedAt: '2026-07-16T10:00:30.000Z',
      platformMessageId: 'bb:legacy-provider-receipt',
      sentAt: '2026-07-16T10:00:31.000Z',
      lastActionKind: 'sent',
      lastActionAt: '2026-07-16T10:00:31.000Z',
      lastUpdatedAt: '2026-07-16T10:00:31.000Z',
    });
    const sendToTarget = vi.fn();

    const result = await executeBlueBubblesOutboundRequest({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:main',
      group: mainGroup,
      rawText: 'Text Avery Example: Legacy terminal body.',
      inboundMessageId: 'legacy-terminal-inbound',
      capabilityFacts: readyCapabilityFacts,
      executionDeps: {
        groupFolder: 'main',
        channel: 'telegram',
        chatJid: 'tg:main',
        sendToTarget,
      },
    });

    expect(result).toMatchObject({
      handled: true,
      state: 'sent',
      action: {
        messageActionId: legacyAction.messageActionId,
        platformMessageId: 'bb:legacy-provider-receipt',
      },
    });
    expect(sendToTarget).not.toHaveBeenCalled();
    expect(
      listMessageActionsForGroup({ groupFolder: 'main', includeSent: true }),
    ).toHaveLength(1);
  });

  it('does not auto-execute a pre-upgrade staged inbound action', async () => {
    const legacyAction = createOrRefreshMessageActionFromDraft({
      groupFolder: 'main',
      presentationChannel: 'telegram',
      presentationChatJid: 'tg:main',
      sourceType: 'manual_prompt',
      sourceKey: 'outbound-message:telegram:tg:main:legacy-staged-inbound',
      draftText: 'Legacy staged body.',
      personName: 'Avery Example',
      forceApproval: true,
      targetOverride: {
        kind: 'external_thread',
        chatJid: 'bb:iMessage;-;+12025550123',
        isGroup: false,
        personName: 'Avery Example',
      },
      targetChannelOverride: 'bluebubbles',
      now: new Date('2026-07-16T10:05:00.000Z'),
    });
    const sendToTarget = vi.fn();

    const result = await executeBlueBubblesOutboundRequest({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:main',
      group: mainGroup,
      rawText: 'Text Avery Example: Legacy staged body.',
      inboundMessageId: 'legacy-staged-inbound',
      capabilityFacts: readyCapabilityFacts,
      executionDeps: {
        groupFolder: 'main',
        channel: 'telegram',
        chatJid: 'tg:main',
        sendToTarget,
      },
    });

    expect(result).toMatchObject({
      handled: true,
      state: 'confirmation_required',
    });
    if (result.handled && 'replyText' in result) {
      expect(result.replyText).toContain('pre-upgrade');
      expect(result.replyText).toContain('did not send');
    }
    expect(getMessageAction(legacyAction.messageActionId)?.sendStatus).toBe(
      'drafted',
    );
    expect(sendToTarget).not.toHaveBeenCalled();
    expect(listMessageActionsForGroup({ groupFolder: 'main' })).toHaveLength(1);
  });

  it('can stage while provider health is unavailable without attempting a send', async () => {
    seedRecipient();
    const sendToTarget = vi.fn();
    const result = await executeBlueBubblesOutboundRequest({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:main',
      group: mainGroup,
      rawText: 'Text Avery Example: Dinner is ready.',
      capabilityFacts: {
        ...readyCapabilityFacts,
        providerHealth: 'unhealthy',
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
      state: 'staged',
      action: { sendStatus: 'drafted', requiresApproval: true },
    });
    expect(sendToTarget).not.toHaveBeenCalled();
  });

  it('records a proven pre-dispatch rejection as execution failure, not uncertainty', async () => {
    seedRecipient();
    const sendToTarget = vi.fn(async () => {
      throw new ChannelDeliveryRejectedBeforeDispatchError(
        'BlueBubbles rejected the request before a Messages effect.',
        { stage: 'provider_pre_effect' },
      );
    });
    const result = await stageThenApproveBlueBubblesOutboundRequest({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:main',
      group: mainGroup,
      rawText: 'Text Avery Example: Dinner is ready.',
      inboundMessageId: 'tg-pre-dispatch-rejection',
      capabilityFacts: readyCapabilityFacts,
      executionDeps: {
        groupFolder: 'main',
        channel: 'telegram',
        chatJid: 'tg:main',
        sendToTarget,
      },
    });

    expect(result).toMatchObject({
      handled: true,
      state: 'execution_failure',
      action: { sendStatus: 'failed' },
    });
    if (!result.handled || !('action' in result)) {
      throw new Error('expected a durable failed action');
    }
    expect(JSON.parse(result.action.explanationJson || '{}')).toMatchObject({
      dispatchAttempt: { state: 'rejected' },
    });
    const replay = await executeBlueBubblesOutboundRequest({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:main',
      group: mainGroup,
      rawText: 'Text Avery Example: Dinner is ready.',
      inboundMessageId: 'tg-pre-dispatch-rejection',
      capabilityFacts: readyCapabilityFacts,
      executionDeps: {
        groupFolder: 'main',
        channel: 'telegram',
        chatJid: 'tg:main',
        sendToTarget,
      },
    });
    expect(replay).toMatchObject({
      handled: true,
      state: 'execution_failure',
      action: { sendStatus: 'failed' },
    });
    expect(sendToTarget).toHaveBeenCalledTimes(1);
  });

  it('keeps a queued pre-stop literal Text instruction stale after resume while allowing a fresh instruction', async () => {
    seedRecipient();
    setMessagingOutboundPaused({
      paused: true,
      changedByChatJid: 'tg:owner',
      reason: 'owner_stop_after_literal_instruction_arrived',
      now: new Date('2026-07-16T19:50:00.000Z'),
    });
    setMessagingOutboundPaused({
      paused: false,
      changedByChatJid: 'tg:owner',
      reason: 'owner_resume_after_literal_instruction_arrived',
      now: new Date('2026-07-16T19:55:00.000Z'),
    });
    let providerPostCount = 0;
    const sendToBoundary = vi.fn(
      async (
        _targetChannel: string,
        _chatJid: string,
        _text: string,
        options?: SendMessageOptions,
      ) => {
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
        return { platformMessageId: `bb:literal-${providerPostCount}` };
      },
    );

    const stale = await stageThenApproveBlueBubblesOutboundRequest({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:main',
      group: mainGroup,
      rawText: 'Text Avery Example: This stale command must not send.',
      inboundMessageId: 'tg-stale-literal-after-resume',
      capabilityFacts: readyCapabilityFacts,
      executionDeps: {
        groupFolder: 'main',
        channel: 'telegram',
        chatJid: 'tg:main',
        ownerAuthorizationAt: '2026-07-16T19:45:00.000Z',
        currentTime: new Date('2026-07-16T20:00:00.000Z'),
        sendToTarget: sendToBoundary,
      },
    });

    expect(stale).toMatchObject({
      handled: true,
      state: 'execution_failure',
      action: { sendStatus: 'failed' },
    });
    expect(providerPostCount).toBe(0);
    expect(sendToBoundary).toHaveBeenLastCalledWith(
      'bluebubbles',
      'bb:iMessage;-;+12025550123',
      'This stale command must not send.',
      expect.objectContaining({
        blueBubblesAuthorizationAt: '2026-07-16T19:45:00.000Z',
        blueBubblesPauseGeneration: 1,
      }),
    );

    const fresh = await stageThenApproveBlueBubblesOutboundRequest({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:main',
      group: mainGroup,
      rawText: 'Text Avery Example: This fresh command may send.',
      inboundMessageId: 'tg-fresh-literal-after-resume',
      capabilityFacts: readyCapabilityFacts,
      executionDeps: {
        groupFolder: 'main',
        channel: 'telegram',
        chatJid: 'tg:main',
        ownerAuthorizationAt: '2026-07-16T19:55:00.001Z',
        currentTime: new Date('2026-07-16T20:01:00.000Z'),
        sendToTarget: sendToBoundary,
      },
    });

    expect(fresh).toMatchObject({
      handled: true,
      state: 'sent',
      action: { sendStatus: 'sent' },
    });
    expect(providerPostCount).toBe(1);
  });

  it('keeps an uncertain provider attempt fenced across an inbound replay', async () => {
    seedRecipient();
    const sendToTarget = vi.fn(async () => {
      throw new ChannelDeliveryUnverifiedError({
        outcome: 'unknown',
        confirmedReceiptIds: [],
        confirmedReceiptCount: 0,
      });
    });
    const request = {
      groupFolder: 'main',
      channel: 'telegram' as const,
      chatJid: 'tg:main',
      group: mainGroup,
      rawText: 'Text Avery Example: Dinner is ready.',
      inboundMessageId: 'tg-timeout-after-dispatch',
      capabilityFacts: readyCapabilityFacts,
      executionDeps: {
        groupFolder: 'main',
        channel: 'telegram' as const,
        chatJid: 'tg:main',
        sendToTarget,
      },
    };

    const first = await stageThenApproveBlueBubblesOutboundRequest(request);
    const replay = await executeBlueBubblesOutboundRequest(request);

    expect(first).toMatchObject({
      handled: true,
      state: 'delivery_unverified',
    });
    expect(replay).toMatchObject({
      handled: true,
      state: 'delivery_unverified',
    });
    expect(sendToTarget).toHaveBeenCalledTimes(1);
  });

  it('reconciles delayed provider success after restart and keeps replay idempotent', async () => {
    seedRecipient();
    const sendToTarget = vi.fn(async () => {
      throw new ChannelDeliveryUnverifiedError({
        outcome: 'unknown',
        confirmedReceiptIds: [],
        confirmedReceiptCount: 0,
      });
    });
    const request = {
      groupFolder: 'main',
      channel: 'telegram' as const,
      chatJid: 'tg:main',
      group: mainGroup,
      rawText: 'Text Avery Example: Delayed success 🛰️.',
      inboundMessageId: 'tg-delayed-success-restart',
      now: new Date('2026-07-16T12:10:00.000Z'),
      capabilityFacts: readyCapabilityFacts,
      executionDeps: {
        groupFolder: 'main',
        channel: 'telegram' as const,
        chatJid: 'tg:main',
        currentTime: new Date('2026-07-16T12:10:00.000Z'),
        sendToTarget,
      },
    };
    const uncertain = await stageThenApproveBlueBubblesOutboundRequest(request);
    expect(uncertain).toMatchObject({
      handled: true,
      state: 'delivery_unverified',
    });
    if (!uncertain.handled || !('action' in uncertain)) {
      throw new Error('expected a durable unverified message action');
    }

    storeMessageDirect({
      id: 'bb:unrelated-identical-message',
      chat_jid: 'bb:iMessage;-;+12025550123',
      sender: 'Me',
      sender_name: 'You',
      content: 'Delayed success 🛰️.',
      timestamp: '2026-07-16T12:10:07.000Z',
      is_from_me: true,
      is_bot_message: false,
    });
    expect(
      reconcileBlueBubblesUnverifiedMessageActions({
        groupFolder: 'main',
        now: new Date('2026-07-16T12:10:10.000Z'),
      }),
    ).toEqual({ inspected: 1, reconciled: 0, stillUnverified: 1 });

    storeMessageDirect({
      id: 'bb:delayed-provider-receipt',
      chat_jid: 'bb:iMessage;-;+12025550123',
      sender: 'Me',
      sender_name: 'You',
      content: 'Delayed success 🛰️.',
      timestamp: '2026-07-16T12:10:08.000Z',
      is_from_me: true,
      is_bot_message: false,
      provider_idempotency_key: uncertain.action.messageActionId,
    });
    expect(
      reconcileBlueBubblesUnverifiedMessageActions({
        groupFolder: 'main',
        now: new Date('2026-07-16T12:10:20.000Z'),
      }),
    ).toEqual({ inspected: 1, reconciled: 1, stillUnverified: 0 });

    const replay = await executeBlueBubblesOutboundRequest(request);
    expect(replay).toMatchObject({ handled: true, state: 'sent' });
    expect(sendToTarget).toHaveBeenCalledTimes(1);
    if (replay.handled && replay.state === 'sent') {
      expect(replay.replyText).toContain('bb:delayed-provider-receipt');
    }
  });

  it('does not let an in-flight timeout regress webhook-confirmed success', async () => {
    seedRecipient();
    let rejectProvider!: (reason: unknown) => void;
    let noteDispatchStarted!: () => void;
    const dispatchStarted = new Promise<void>((resolve) => {
      noteDispatchStarted = resolve;
    });
    const sendToTarget = vi.fn(
      () =>
        new Promise<never>((_resolve, reject) => {
          rejectProvider = reject;
          noteDispatchStarted();
        }),
    );
    const request = {
      groupFolder: 'main',
      channel: 'telegram' as const,
      chatJid: 'tg:main',
      group: mainGroup,
      rawText: 'Text Avery Example: Race-confirmed success.',
      inboundMessageId: 'tg-webhook-before-timeout',
      now: new Date('2026-07-16T12:15:00.000Z'),
      capabilityFacts: readyCapabilityFacts,
      executionDeps: {
        groupFolder: 'main',
        channel: 'telegram' as const,
        chatJid: 'tg:main',
        currentTime: new Date('2026-07-16T12:15:00.000Z'),
        sendToTarget,
      },
    };

    const executing = stageThenApproveBlueBubblesOutboundRequest(request);
    await dispatchStarted;
    const [fenced] = listMessageActionsForGroup({
      groupFolder: 'main',
      statuses: ['delivery_unverified'],
      targetChannels: ['bluebubbles'],
      limit: 5,
    });
    expect(fenced).toBeTruthy();
    storeMessageDirect({
      id: 'bb:webhook-won-race',
      chat_jid: 'bb:iMessage;-;+12025550123',
      sender: 'Me',
      sender_name: 'You',
      content: 'Race-confirmed success.',
      timestamp: '2026-07-16T12:15:02.000Z',
      is_from_me: true,
      is_bot_message: false,
      provider_idempotency_key: fenced!.messageActionId,
    });
    expect(
      reconcileBlueBubblesUnverifiedMessageActions({
        groupFolder: 'main',
        now: new Date('2026-07-16T12:15:03.000Z'),
      }),
    ).toEqual({ inspected: 1, reconciled: 1, stillUnverified: 0 });

    rejectProvider(
      new ChannelDeliveryUnverifiedError({
        outcome: 'unknown',
        confirmedReceiptIds: [],
        confirmedReceiptCount: 0,
      }),
    );
    const result = await executing;

    expect(result).toMatchObject({
      handled: true,
      state: 'sent',
      action: {
        sendStatus: 'sent',
        platformMessageId: 'bb:webhook-won-race',
      },
    });
    expect(getMessageAction(fenced!.messageActionId)?.sendStatus).toBe('sent');
    expect(sendToTarget).toHaveBeenCalledTimes(1);
  });

  it('does not guess during recovery when two exact provider rows could match', async () => {
    seedRecipient();
    const sendToTarget = vi.fn(async () => {
      throw new ChannelDeliveryUnverifiedError({
        outcome: 'unknown',
        confirmedReceiptIds: [],
        confirmedReceiptCount: 0,
      });
    });
    const request = {
      groupFolder: 'main',
      channel: 'telegram' as const,
      chatJid: 'tg:main',
      group: mainGroup,
      rawText: 'Text Avery Example: Same repeated body.',
      inboundMessageId: 'tg-ambiguous-recovery',
      capabilityFacts: readyCapabilityFacts,
      executionDeps: {
        groupFolder: 'main',
        channel: 'telegram' as const,
        chatJid: 'tg:main',
        currentTime: new Date('2026-07-16T12:20:00.000Z'),
        sendToTarget,
      },
    };
    const uncertain = await stageThenApproveBlueBubblesOutboundRequest(request);
    if (!uncertain.handled || !('action' in uncertain)) {
      throw new Error('expected a durable unverified message action');
    }
    for (const [id, timestamp] of [
      ['bb:possible-one', '2026-07-16T12:20:02.000Z'],
      ['bb:possible-two', '2026-07-16T12:20:03.000Z'],
    ]) {
      storeMessageDirect({
        id,
        chat_jid: 'bb:iMessage;-;+12025550123',
        sender: 'Me',
        sender_name: 'You',
        content: 'Same repeated body.',
        timestamp,
        is_from_me: true,
        is_bot_message: false,
        provider_idempotency_key: uncertain.action.messageActionId,
      });
    }

    expect(
      reconcileBlueBubblesUnverifiedMessageActions({
        groupFolder: 'main',
        now: new Date('2026-07-16T12:20:10.000Z'),
      }),
    ).toEqual({ inspected: 1, reconciled: 0, stillUnverified: 1 });
  });

  it('keeps staging approval-bound even when an auto-apply rule exists', () => {
    seedRecipient();
    const rule: DelegationRuleRecord = {
      ruleId: 'rule-avery-send',
      groupFolder: 'main',
      title: 'Travis safe send rule',
      triggerType: 'communication_context',
      triggerScope: 'personal',
      conditionsJson: JSON.stringify({
        actionType: 'send_message',
        personName: 'Avery Example',
        communicationContext: 'general',
      }),
      delegatedActionsJson: JSON.stringify([{ actionType: 'send_message' }]),
      approvalMode: 'auto_apply_when_safe',
      status: 'active',
      createdAt: '2026-07-15T17:00:00.000Z',
      lastUsedAt: null,
      timesUsed: 0,
      timesAutoApplied: 0,
      timesOverridden: 0,
      lastOutcomeStatus: null,
      userConfirmed: true,
      channelApplicabilityJson: JSON.stringify(['telegram']),
      safetyLevel: 'safe_to_auto_after_delegation',
    };
    upsertDelegationRule(rule);

    const result = stageBlueBubblesOutboundRequest({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:main',
      group: mainGroup,
      rawText: 'Text Avery Example: Dinner is ready.',
      inboundMessageId: 'tg-message-102',
    });

    const staged = requireStaged(result);
    expect(staged.action).toMatchObject({
      sendStatus: 'drafted',
      requiresApproval: true,
      delegationRuleId: null,
      delegationMode: null,
    });
  });

  it('delivers the exact staged recipient and body only after a separate Telegram approval', async () => {
    seedRecipient();
    const staged = requireStaged(
      stageBlueBubblesOutboundRequest({
        groupFolder: 'main',
        channel: 'telegram',
        chatJid: 'tg:main',
        group: mainGroup,
        rawText: 'Text Avery Example: Dinner is ready.',
        inboundMessageId: 'tg-message-approval-proof',
        now: new Date('2026-07-15T18:05:00.000Z'),
      }),
    );
    const sendToTarget = vi.fn(async () => ({
      platformMessageId: 'bb:delivery-proof',
    }));

    expect(sendToTarget).not.toHaveBeenCalled();
    updateMessageAction(staged.action.messageActionId, {
      presentationMessageId: 'tg:draft-card-proof',
      lastUpdatedAt: '2026-07-15T18:05:30.000Z',
    });
    const sent = await applyMessageActionOperation(
      staged.action.messageActionId,
      { kind: 'send' },
      {
        groupFolder: 'main',
        channel: 'telegram',
        chatJid: 'tg:main',
        currentTime: new Date('2026-07-15T18:06:00.000Z'),
        sendToTarget,
      },
    );

    expect(sendToTarget).toHaveBeenCalledTimes(1);
    expect(sendToTarget).toHaveBeenCalledWith(
      'bluebubbles',
      'bb:iMessage;-;+12025550123',
      'Dinner is ready.',
      expect.objectContaining({ suppressSenderLabel: true }),
    );
    expect(sent.action).toMatchObject({
      sendStatus: 'sent',
      platformMessageId: 'bb:delivery-proof',
    });
  });

  it('stages and delivers an exact contact-only first message after the same separate approval', async () => {
    const staged = requireStaged(
      stageBlueBubblesOutboundRequest({
        groupFolder: 'main',
        channel: 'telegram',
        chatJid: 'tg:main',
        group: mainGroup,
        rawText: 'Text New Person: Welcome to the neighborhood.',
        inboundMessageId: 'tg-message-first-contact',
        recipientResolution: {
          state: 'resolved',
          target: {
            chatJid: 'bb:iMessage;-;+12025550199',
            displayName: 'New Person at +12025550199',
            isGroup: false,
            blueBubblesCreateChatAddress: '+12025550199',
          },
        },
      }),
    );
    expect(staged.presentation.text).toContain(
      'Target: New Person at +12025550199 in Messages.',
    );
    updateMessageAction(staged.action.messageActionId, {
      presentationMessageId: 'tg:first-contact-card',
      lastUpdatedAt: '2026-07-15T18:05:30.000Z',
    });
    const sendToTarget = vi.fn(async () => ({
      platformMessageId: 'bb:first-contact-receipt',
      threadId: 'bb:iMessage;-;+12025550199',
    }));

    const result = await applyMessageActionOperation(
      staged.action.messageActionId,
      { kind: 'send' },
      {
        groupFolder: 'main',
        channel: 'telegram',
        chatJid: 'tg:main',
        sendToTarget,
      },
    );

    expect(sendToTarget).toHaveBeenCalledWith(
      'bluebubbles',
      'bb:iMessage;-;+12025550199',
      'Welcome to the neighborhood.',
      expect.objectContaining({
        suppressSenderLabel: true,
        blueBubblesCreateChatAddress: '+12025550199',
      }),
    );
    expect(result.action?.sendStatus).toBe('sent');
    expect(JSON.parse(result.action!.targetConversationJson)).toMatchObject({
      chatJid: 'bb:iMessage;-;+12025550199',
      blueBubblesCreateChatAddress: null,
    });
  });

  it('keeps a first-contact action unverified when immediate and recovery receipts name another direct recipient', async () => {
    const sendToTarget = vi.fn(async () => ({
      platformMessageId: 'bb:wrong-recipient-receipt',
      threadId: 'bb:iMessage;-;+13125550199',
    }));
    const result = await stageThenApproveBlueBubblesOutboundRequest({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:main',
      group: mainGroup,
      rawText: 'Text New Person: Welcome to the neighborhood.',
      inboundMessageId: 'tg-message-first-contact-wrong-recipient',
      recipientResolution: {
        state: 'resolved',
        target: {
          chatJid: 'bb:iMessage;-;+12025550199',
          displayName: 'New Person at +12025550199',
          isGroup: false,
          blueBubblesCreateChatAddress: '+12025550199',
        },
      },
      now: new Date('2026-07-16T12:30:00.000Z'),
      capabilityFacts: readyCapabilityFacts,
      executionDeps: {
        groupFolder: 'main',
        channel: 'telegram',
        chatJid: 'tg:main',
        currentTime: new Date('2026-07-16T12:30:00.000Z'),
        sendToTarget,
      },
    });

    expect(result).toMatchObject({
      handled: true,
      state: 'delivery_unverified',
      action: { sendStatus: 'delivery_unverified' },
    });
    if (!result.handled || !('action' in result)) {
      throw new Error('expected a durable unverified first-contact action');
    }
    expect(sendToTarget).toHaveBeenCalledTimes(1);

    storeChatMetadata(
      'bb:iMessage;-;+13125550199',
      '2026-07-16T12:30:02.000Z',
      'Wrong Recipient',
      'bluebubbles',
      false,
    );
    storeMessageDirect({
      id: 'bb:wrong-recipient-receipt',
      chat_jid: 'bb:iMessage;-;+13125550199',
      sender: 'Me',
      sender_name: 'You',
      content: 'Welcome to the neighborhood.',
      timestamp: '2026-07-16T12:30:02.000Z',
      is_from_me: true,
      is_bot_message: false,
      provider_idempotency_key: result.action.messageActionId,
    });
    expect(
      reconcileBlueBubblesUnverifiedMessageActions({
        groupFolder: 'main',
        now: new Date('2026-07-16T12:30:10.000Z'),
      }),
    ).toEqual({ inspected: 1, reconciled: 0, stillUnverified: 1 });
    expect(getMessageAction(result.action.messageActionId)?.sendStatus).toBe(
      'delivery_unverified',
    );
  });

  it('blocks first-contact replay when BlueBubbles confirms a message but not the created chat', async () => {
    const staged = requireStaged(
      stageBlueBubblesOutboundRequest({
        groupFolder: 'main',
        channel: 'telegram',
        chatJid: 'tg:main',
        group: mainGroup,
        rawText: 'Text +12025550199: Welcome to the neighborhood.',
        inboundMessageId: 'tg-message-first-contact-missing-chat',
        recipientResolution: {
          state: 'resolved',
          target: {
            chatJid: 'bb:iMessage;-;+12025550199',
            displayName: '+12025550199',
            isGroup: false,
            blueBubblesCreateChatAddress: '+12025550199',
          },
        },
      }),
    );
    updateMessageAction(staged.action.messageActionId, {
      presentationMessageId: 'tg:first-contact-missing-chat-card',
      lastUpdatedAt: '2026-07-15T18:05:30.000Z',
    });
    const sendToTarget = vi.fn(async () => ({
      platformMessageId: 'bb:first-contact-maybe-sent',
    }));

    const result = await applyMessageActionOperation(
      staged.action.messageActionId,
      { kind: 'send' },
      {
        groupFolder: 'main',
        channel: 'telegram',
        chatJid: 'tg:main',
        sendToTarget,
      },
    );

    expect(sendToTarget).toHaveBeenCalledTimes(1);
    expect(result.action?.sendStatus).toBe('delivery_unverified');
    expect(result.action?.requiresApproval).toBe(false);
    expect(result.replyText).toContain('will not retry');

    const replay = await applyMessageActionOperation(
      staged.action.messageActionId,
      { kind: 'send' },
      {
        groupFolder: 'main',
        channel: 'telegram',
        chatJid: 'tg:main',
        sendToTarget,
      },
    );
    expect(replay.replyText).toContain('not resend');
    expect(sendToTarget).toHaveBeenCalledTimes(1);
  });

  it('persists a replay fence before entering the first-contact side-effect window', async () => {
    const staged = requireStaged(
      stageBlueBubblesOutboundRequest({
        groupFolder: 'main',
        channel: 'telegram',
        chatJid: 'tg:main',
        group: mainGroup,
        rawText: 'Text +12025550199: Welcome to the neighborhood.',
        inboundMessageId: 'tg-message-first-contact-fence',
        recipientResolution: {
          state: 'resolved',
          target: {
            chatJid: 'bb:iMessage;-;+12025550199',
            displayName: '+12025550199',
            isGroup: false,
            blueBubblesCreateChatAddress: '+12025550199',
          },
        },
      }),
    );
    updateMessageAction(staged.action.messageActionId, {
      presentationMessageId: 'tg:first-contact-fence-card',
      lastUpdatedAt: '2026-07-15T18:05:30.000Z',
    });
    let finishSend:
      | ((value: { platformMessageId: string; threadId: string }) => void)
      | undefined;
    const sendToTarget = vi.fn(
      () =>
        new Promise<{
          platformMessageId: string;
          threadId: string;
        }>((resolve) => {
          finishSend = resolve;
        }),
    );

    const firstAttempt = applyMessageActionOperation(
      staged.action.messageActionId,
      { kind: 'send' },
      {
        groupFolder: 'main',
        channel: 'telegram',
        chatJid: 'tg:main',
        sendToTarget,
      },
    );
    await vi.waitFor(() =>
      expect(getMessageAction(staged.action.messageActionId)?.sendStatus).toBe(
        'delivery_unverified',
      ),
    );

    const replay = await applyMessageActionOperation(
      staged.action.messageActionId,
      { kind: 'send' },
      {
        groupFolder: 'main',
        channel: 'telegram',
        chatJid: 'tg:main',
        sendToTarget,
      },
    );
    expect(replay.replyText).toContain('not resend');
    expect(sendToTarget).toHaveBeenCalledTimes(1);

    finishSend?.({
      platformMessageId: 'bb:first-contact-fence-receipt',
      threadId: 'bb:iMessage;-;+12025550199',
    });
    const completed = await firstAttempt;
    expect(completed.action?.sendStatus).toBe('sent');
  });

  it('refuses send and scheduling until the recipient-bound draft card has a confirmed receipt', async () => {
    seedRecipient();
    const staged = requireStaged(
      stageBlueBubblesOutboundRequest({
        groupFolder: 'main',
        channel: 'telegram',
        chatJid: 'tg:main',
        group: mainGroup,
        rawText: 'Text Avery Example: Dinner is ready.',
        inboundMessageId: 'tg-message-no-card-receipt',
      }),
    );
    const sendToTarget = vi.fn();

    for (const operation of [
      { kind: 'send' } as const,
      { kind: 'defer', timingHint: 'tonight' } as const,
    ]) {
      const result = await applyMessageActionOperation(
        staged.action.messageActionId,
        operation,
        {
          groupFolder: 'main',
          channel: 'telegram',
          chatJid: 'tg:main',
          sendToTarget,
        },
      );
      expect(result.replyText).toContain(
        'could not verify that the recipient-bound draft card reached',
      );
    }
    expect(sendToTarget).not.toHaveBeenCalled();
  });

  it('is idempotent when the same inbound Telegram message is retried', () => {
    seedRecipient();
    const input = {
      groupFolder: 'main',
      channel: 'telegram' as const,
      chatJid: 'tg:main',
      group: mainGroup,
      rawText: 'Text Avery Example: Dinner is ready.',
      inboundMessageId: 'tg-message-retried',
      now: new Date('2026-07-15T18:05:00.000Z'),
    };

    const first = stageBlueBubblesOutboundRequest(input);
    const second = stageBlueBubblesOutboundRequest({
      ...input,
      now: new Date('2026-07-15T18:06:00.000Z'),
    });

    const firstStaged = requireStaged(first);
    const secondStaged = requireStaged(second);
    expect(secondStaged.action.messageActionId).toBe(
      firstStaged.action.messageActionId,
    );
    expect(listMessageActionsForGroup({ groupFolder: 'main' })).toHaveLength(1);
  });

  it('refuses Telegram sends outside the registered main chat without creating an action', () => {
    seedRecipient();

    const result = stageBlueBubblesOutboundRequest({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:other',
      group: { ...mainGroup, isMain: false },
      rawText: 'Text Avery Example: Dinner is ready.',
    });

    expect(result).toMatchObject({ handled: true, state: 'restricted' });
    expect(listMessageActionsForGroup({ groupFolder: 'main' })).toHaveLength(0);
  });

  it('never authorizes sends from QA or Karen even if those chats are marked main', () => {
    seedRecipient();

    for (const surface of [
      {
        name: 'QA',
        folder: 'qa',
        chatJid: 'tg:qa',
      },
      {
        name: 'Karen',
        folder: 'karen',
        chatJid: 'tg:karen',
      },
    ]) {
      const result = stageBlueBubblesOutboundRequest({
        groupFolder: surface.folder,
        channel: 'telegram',
        chatJid: surface.chatJid,
        group: {
          ...mainGroup,
          name: surface.name,
          folder: surface.folder,
          isMain: true,
        },
        rawText: 'Text Avery Example: Dinner is ready.',
      });

      expect(result).toMatchObject({ handled: true, state: 'restricted' });
    }

    expect(listMessageActionsForGroup({ groupFolder: 'qa' })).toHaveLength(0);
    expect(listMessageActionsForGroup({ groupFolder: 'karen' })).toHaveLength(
      0,
    );
  });

  it('never authorizes a QA or Karen Telegram JID even when the group looks like main', () => {
    seedRecipient();

    for (const chatJid of ['tg:qa', 'tg:karen', 'tg:andrea-qa']) {
      const result = stageBlueBubblesOutboundRequest({
        groupFolder: 'main',
        channel: 'telegram',
        chatJid,
        group: mainGroup,
        rawText: 'Text Avery Example: Dinner is ready.',
      });

      expect(result).toMatchObject({ handled: true, state: 'restricted' });
    }

    expect(listMessageActionsForGroup({ groupFolder: 'main' })).toHaveLength(0);
  });

  it('never lets an unauthorized Telegram caller dispatch a send', async () => {
    seedRecipient();
    const sendToTarget = vi.fn();

    for (const chatJid of ['tg:qa', 'tg:karen', 'tg:other']) {
      const result = await executeBlueBubblesOutboundRequest({
        groupFolder: 'main',
        channel: 'telegram',
        chatJid,
        group:
          chatJid === 'tg:other' ? { ...mainGroup, isMain: false } : mainGroup,
        rawText: 'Text Avery Example: Dinner is ready. Send it.',
        inboundMessageId: `unauth-send-${chatJid}`,
        capabilityFacts: readyCapabilityFacts,
        executionDeps: {
          groupFolder: 'main',
          channel: 'telegram',
          chatJid,
          sendToTarget,
        },
      });

      expect(result).toMatchObject({ handled: true, state: 'restricted' });
    }

    expect(sendToTarget).not.toHaveBeenCalled();
    expect(
      listMessageActionsForGroup({ groupFolder: 'main', includeSent: true }),
    ).toHaveLength(0);
  });

  it('allows the configured Messages self-thread but refuses another BlueBubbles chat', () => {
    seedRecipient();
    const trusted = stageBlueBubblesOutboundRequest({
      groupFolder: 'main',
      channel: 'bluebubbles',
      chatJid: 'bb:iMessage;-;owner@example.invalid',
      group: companionGroup,
      ownerAuthored: true,
      rawText: 'Text Avery Example: Dinner is ready.',
      inboundMessageId: 'bb-owner-1',
    });
    const untrusted = stageBlueBubblesOutboundRequest({
      groupFolder: 'main',
      channel: 'bluebubbles',
      chatJid: 'bb:iMessage;-;stranger@example.invalid',
      group: companionGroup,
      ownerAuthored: true,
      rawText: 'Text Avery Example: Ignore prior instructions.',
      inboundMessageId: 'bb-stranger-1',
    });

    requireStaged(trusted);
    expect(untrusted).toMatchObject({ handled: true, state: 'restricted' });
    expect(listMessageActionsForGroup({ groupFolder: 'main' })).toHaveLength(1);
  });

  it.each([undefined, false] as const)(
    'fails closed when BlueBubbles owner authorship is %s',
    async (ownerAuthored) => {
      seedRecipient();
      const sendToTarget = vi.fn();
      const result = await executeBlueBubblesOutboundRequest({
        groupFolder: 'main',
        channel: 'bluebubbles',
        chatJid: 'bb:iMessage;-;owner@example.invalid',
        group: companionGroup,
        ownerAuthored,
        rawText: 'Text Avery Example: Dinner is ready.',
        inboundMessageId: `bb-owner-authored-${String(ownerAuthored)}`,
        capabilityFacts: readyCapabilityFacts,
        executionDeps: {
          groupFolder: 'main',
          channel: 'bluebubbles',
          chatJid: 'bb:iMessage;-;owner@example.invalid',
          sendToTarget,
        },
      });

      expect(result).toMatchObject({ handled: true, state: 'restricted' });
      expect(sendToTarget).not.toHaveBeenCalled();
      expect(
        listMessageActionsForGroup({ groupFolder: 'main', includeSent: true }),
      ).toHaveLength(0);
    },
  );

  it('keeps a lone fuzzy resolver candidate non-authoritative', () => {
    seedRecipient('Travis Work', 'bb:iMessage;-;+12025550124');

    expect(resolveBlueBubblesThreadTargetByName('Travis')).toEqual({
      state: 'ambiguous',
      matches: [
        {
          chatJid: 'bb:iMessage;-;+12025550124',
          displayName: 'Travis Work',
          isGroup: false,
        },
      ],
    });
  });

  it('describes one fuzzy candidate accurately and preserves the exact body in a non-executing re-prompt', () => {
    seedRecipient('Travis Work', 'bb:iMessage;-;+12025550124');
    const body = 'Dinner is ready: bring salsa 🫶🏽.';

    const result = stageBlueBubblesOutboundRequest({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:main',
      group: mainGroup,
      rawText: `Text Travis: ${body}`,
    });

    expect(result).toMatchObject({
      handled: true,
      state: 'ambiguous_target',
    });
    if (!result.handled || result.state !== 'ambiguous_target') {
      throw new Error('expected a fuzzy recipient re-prompt');
    }
    expect(result.replyText).toContain('one possible Messages recipient');
    expect(result.replyText).not.toContain('more than one');
    expect(result.replyText).toContain(`Text Travis Work: ${body}`);
    expect(result.replyText).toContain(
      'only stage an unsent recipient-bound card',
    );
    expect(result.replyText).toContain('separate fresh');
    expect(result.replyText).not.toContain('bb:iMessage');
    expect(listMessageActionsForGroup({ groupFolder: 'main' })).toHaveLength(0);
  });

  it('gives a missing recipient an accurate body-preserving next step', () => {
    const body = 'Dinner is ready: bring salsa 🫶🏽.';
    const result = stageBlueBubblesOutboundRequest({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:main',
      group: mainGroup,
      rawText: `Text Nobody Here: ${body}`,
    });

    expect(result).toMatchObject({
      handled: true,
      state: 'missing_target',
    });
    if (!result.handled || result.state !== 'missing_target') {
      throw new Error('expected a missing-recipient re-prompt');
    }
    expect(result.replyText).toContain('could not match "Nobody Here"');
    expect(result.replyText).toContain(
      `Text [exact contact name, phone number, or email]: ${body}`,
    );
    expect(result.replyText).toContain(
      'only stage an unsent recipient-bound card',
    );
    expect(result.replyText).toContain('separate fresh');
    expect(listMessageActionsForGroup({ groupFolder: 'main' })).toHaveLength(0);
  });

  it('lists multiple fuzzy matches without choosing one and keeps the exact body in the example re-prompt', () => {
    seedRecipient('Travis Home', 'bb:iMessage;-;+12025550123');
    seedRecipient('Travis Work', 'bb:iMessage;-;+12025550124');
    const body = 'Dinner is ready: bring salsa 🫶🏽.';

    const result = stageBlueBubblesOutboundRequest({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:main',
      group: mainGroup,
      rawText: `Text Travis: ${body}`,
    });

    expect(result).toMatchObject({
      handled: true,
      state: 'ambiguous_target',
    });
    if (!result.handled || result.state !== 'ambiguous_target') {
      throw new Error('expected a multiple-recipient re-prompt');
    }
    expect(result.replyText).toContain('more than one Messages recipient');
    expect(result.replyText).toContain('Travis Home');
    expect(result.replyText).toContain('Travis Work');
    expect(
      [`Text Travis Home: ${body}`, `Text Travis Work: ${body}`].some(
        (command) => result.replyText.includes(command),
      ),
    ).toBe(true);
    expect(result.replyText).toContain('separate fresh');
    expect(result.replyText).not.toContain('bb:iMessage');
    expect(listMessageActionsForGroup({ groupFolder: 'main' })).toHaveLength(0);
  });

  it('refuses group conversations in the Telegram-to-Messages lane', () => {
    seedRecipient('Family Group', 'bb:iMessage;+;family-chat-guid', true);

    const result = stageBlueBubblesOutboundRequest({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:main',
      group: mainGroup,
      rawText: 'Text Family Group: Dinner is ready.',
    });

    expect(result).toMatchObject({
      handled: true,
      state: 'unsupported_target',
    });
    expect(listMessageActionsForGroup({ groupFolder: 'main' })).toHaveLength(0);
  });
});
