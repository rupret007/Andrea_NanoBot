import {
  parseAssistantMessageActionIntent,
  type AssistantMessageActionIntent,
} from './assistant-action-intent.js';
import {
  type ExecuteBlueBubblesOutboundRequestParams,
  type ExecuteBlueBubblesOutboundRequestResult,
  readTerminalBlueBubblesOutboundReplay,
  type StageBlueBubblesOutboundRequestParams,
} from './bluebubbles-outbound-request.js';
import {
  resolveBlueBubblesContactRecipient,
  resolveBlueBubblesConfig,
} from './channels/bluebubbles.js';
import { resolveBlueBubblesThreadTargetByName } from './message-actions.js';
import type { MessageActionExecutionDeps } from './message-actions.js';
import {
  buildBlueBubblesRuntimeCapabilityFacts,
  formatRuntimeCapabilityEvaluation,
  runtimeCapabilityRegistry,
  type RuntimeCapabilityRegistry,
} from './runtime-capability-registry.js';
import { isTrustedOwnerReviewSurface } from './trusted-owner-review-surface.js';
import type {
  BlueBubblesChannelControlSnapshot,
  RegisteredGroup,
} from './types.js';

type OutboundChannel = StageBlueBubblesOutboundRequestParams['channel'];
type RecipientResolution =
  StageBlueBubblesOutboundRequestParams['recipientResolution'];
type DefinedRecipientResolution = Exclude<RecipientResolution, undefined>;
type ResolvedRecipient = Extract<
  DefinedRecipientResolution,
  { state: 'resolved' }
>['target'];

function blueBubblesAddressIdentityKeys(
  value: string | null | undefined,
): string[] {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return [];
  if (normalized.includes('@')) return [`email:${normalized}`];
  const digits = normalized.replace(/\D/g, '');
  if (digits.length >= 7) {
    const keys = new Set([`phone:${digits}`]);
    if (digits.length === 11 && digits.startsWith('1')) {
      keys.add(`phone:${digits.slice(1)}`);
    }
    return [...keys];
  }
  return [`raw:${normalized}`];
}

function blueBubblesRecipientIdentityKeys(
  target: ResolvedRecipient,
): Set<string> {
  const normalizedJid = target.chatJid.trim().toLowerCase();
  const keys = new Set<string>();
  if (normalizedJid) keys.add(`jid:${normalizedJid}`);

  const chatGuid = normalizedJid.replace(/^bb:/, '');
  const directAddress = /^[^;]+;-;(.+)$/.exec(chatGuid)?.[1];
  for (const address of [directAddress, target.blueBubblesCreateChatAddress]) {
    for (const key of blueBubblesAddressIdentityKeys(address)) keys.add(key);
  }
  return keys;
}

function recipientsHaveSameIdentity(
  stored: ResolvedRecipient,
  live: ResolvedRecipient,
): boolean {
  const storedKeys = blueBubblesRecipientIdentityKeys(stored);
  const liveKeys = blueBubblesRecipientIdentityKeys(live);
  return [...storedKeys].some((key) => liveKeys.has(key));
}

function mergeBlueBubblesRecipientTruth(
  stored: DefinedRecipientResolution,
  live: DefinedRecipientResolution,
): DefinedRecipientResolution {
  if (stored.state === 'ambiguous') return stored;
  if (stored.state === 'resolved' && stored.target.isGroup) return stored;
  if (live.state === 'ambiguous') return live;
  if (stored.state === 'missing') return live;
  if (live.state === 'missing') return stored;
  if (recipientsHaveSameIdentity(stored.target, live.target)) return stored;
  return {
    state: 'ambiguous',
    matches: [stored.target, live.target],
  };
}

export interface BlueBubblesOutboundTurnChannel {
  getControlSnapshot(): BlueBubblesChannelControlSnapshot;
  refreshControlState(
    mode: 'transport',
  ): Promise<BlueBubblesChannelControlSnapshot>;
}

export interface ExecuteBlueBubblesOutboundTurnParams {
  groupFolder: string;
  channel: OutboundChannel;
  chatJid: string;
  group: RegisteredGroup;
  /** Exact authorship fact from the current inbound platform message. */
  readonly ownerAuthored?: boolean | null;
  rawText: string;
  inboundMessageId?: string | null;
  now?: Date;
  blueBubblesChannel?: BlueBubblesOutboundTurnChannel | null;
  executionDeps: MessageActionExecutionDeps;
  registry?: RuntimeCapabilityRegistry;
  resolveStoredRecipient?: typeof resolveBlueBubblesThreadTargetByName;
  resolveLiveRecipient?: typeof resolveBlueBubblesContactRecipient;
  resolveConfig?: typeof resolveBlueBubblesConfig;
  resolveContextBoundRecipient?: (input: {
    intent: AssistantMessageActionIntent;
  }) => Promise<
    | {
        state: 'resolved';
        recipientResolution: DefinedRecipientResolution;
      }
    | {
        state: 'blocked';
        result: ExecuteBlueBubblesOutboundRequestResult;
      }
  >;
  onRefreshFailure?: (error: unknown) => void;
  onRecipientLookupFailure?: (error: unknown) => void;
}

/**
 * Production integration boundary for an owner Messages request. It refreshes
 * transport truth for an execute intent, requires a successful live directory
 * observation before trusting an exact stored direct thread, and invokes only
 * the executable binding held by the same registry used for preflight and
 * response truth.
 */
export async function executeBlueBubblesOutboundTurn(
  params: ExecuteBlueBubblesOutboundTurnParams,
): Promise<ExecuteBlueBubblesOutboundRequestResult> {
  const registry = params.registry ?? runtimeCapabilityRegistry;
  const intent = parseAssistantMessageActionIntent(params.rawText);
  if (intent?.kind !== 'message_send') return { handled: false };

  // Establish owner authority before refreshing transport state, querying the
  // live directory, reading a replay fence, or invoking an executable binding.
  // A configured BlueBubbles self-thread identifies only the conversation;
  // the exact current message must also be self-authored.
  if (
    !isTrustedOwnerReviewSurface({
      channelName: params.channel,
      chatJid: params.chatJid,
      group: params.group,
      ownerAuthored: params.ownerAuthored,
    })
  ) {
    return {
      handled: true,
      state: 'restricted',
      replyText:
        'Andrea: BlueBubbles execution is private to your registered main Telegram chat or a self-authored instruction in the configured Messages self-thread. I did not create, query, or send anything.',
    };
  }

  const terminalReplay = await readTerminalBlueBubblesOutboundReplay({
    groupFolder: params.groupFolder,
    channel: params.channel,
    chatJid: params.chatJid,
    group: params.group,
    ownerAuthored: params.ownerAuthored,
    rawText: params.rawText,
    inboundMessageId: params.inboundMessageId,
    executionDeps: params.executionDeps,
  });
  if (terminalReplay) return terminalReplay;

  let control = params.blueBubblesChannel?.getControlSnapshot() ?? null;
  if (
    (intent.mode === 'execute' || intent.mode === 'inform') &&
    params.blueBubblesChannel
  ) {
    try {
      control =
        await params.blueBubblesChannel.refreshControlState('transport');
    } catch (error) {
      // A failed explicit refresh invalidates cached healthy state. Execution
      // remains fail-closed until a current transport observation succeeds.
      control = null;
      params.onRefreshFailure?.(error);
    }
  }

  const descriptor = registry.get(intent.capabilityId);
  const binding = registry.getToolBinding(intent.capabilityId);
  const capabilityFacts = buildBlueBubblesRuntimeCapabilityFacts(
    control,
    {
      // An informational question asks whether a future explicit send would be
      // available. Treat confirmation as hypothetically satisfied for that
      // read-only capability check so the answer reflects transport,
      // registration, and permission truth instead of saying only that no
      // current send was authorized.
      explicitlyAuthorized:
        intent.mode === 'inform' || intent.explicitlyAuthorizesExecution,
      toolRegistered: Boolean(binding),
      toolExposed: Boolean(
        binding && descriptor?.sourceChannels.includes(params.channel),
      ),
    },
    registry,
  );

  if (intent.mode === 'inform') {
    const evaluation = registry.evaluate(
      {
        capabilityId: intent.capabilityId,
        action: 'send',
        sourceChannel: params.channel,
      },
      capabilityFacts,
    );
    if (evaluation.state === 'available') {
      return {
        handled: true,
        state: 'capability_status',
        replyText:
          'Yes. BlueBubbles is connected and sending is enabled. From this registered Telegram chat or your configured Messages self-thread, say something like `Text Candace: Yes, please pick them up.` I will resolve the exact recipient, send through BlueBubbles, and only report “Sent” after a provider receipt. Say `Draft a text to Candace: ...` when you want to review it first.',
      };
    }
    return {
      handled: true,
      state: 'capability_status',
      replyText: `BlueBubbles messaging is part of this assistant, but sending is not available right now. ${
        formatRuntimeCapabilityEvaluation(evaluation) ||
        'The current provider state could not be verified.'
      } I can still help review or summarize the Messages history already synced here.`,
    };
  }

  let recipientResolution: RecipientResolution = undefined;
  if (intent.mode === 'execute' && intent.contextBinding) {
    const capability = registry.evaluate(
      {
        capabilityId: intent.capabilityId,
        action: 'send',
        sourceChannel: params.channel,
      },
      capabilityFacts,
    );
    // Provider/context hydration belongs after owner authority and terminal
    // replay, but before a fresh side effect. If the send lane itself is down,
    // preserve that authoritative capability result without exposing review
    // context or doing unnecessary provider reads.
    if (capability.state === 'available') {
      if (!params.resolveContextBoundRecipient) {
        return {
          handled: true,
          state: 'context_unavailable',
          replyText:
            'I could not safely bind that numbered reply to a current Messages review, so I did not send anything. Ask me to review recent texts again.',
        };
      }
      const contextResolution = await params.resolveContextBoundRecipient({
        intent,
      });
      if (contextResolution.state === 'blocked') {
        return contextResolution.result;
      }
      recipientResolution = contextResolution.recipientResolution;
    }
  }
  if (intent.targetLabel && !recipientResolution) {
    // A context-bound recipient was revalidated against current provider
    // history above. Do not let a looser name lookup redirect that exact
    // thread; only unresolved ordinary requests enter this name-lookup lane.
    const resolveStored =
      params.resolveStoredRecipient ?? resolveBlueBubblesThreadTargetByName;
    const resolveLive =
      params.resolveLiveRecipient ?? resolveBlueBubblesContactRecipient;
    const capability = registry.evaluate(
      {
        capabilityId: intent.capabilityId,
        action: 'send',
        sourceChannel: params.channel,
      },
      capabilityFacts,
    );

    if (intent.mode === 'execute' && capability.state === 'available') {
      const stored = resolveStored(intent.targetLabel);
      if (
        stored.state === 'ambiguous' ||
        (stored.state === 'resolved' && stored.target.isGroup)
      ) {
        // Persisted ambiguity and authoritative group GUIDs are terminal. A
        // same-name address-book entry must never redirect either request.
        recipientResolution = stored;
      } else {
        try {
          const configured = (
            params.resolveConfig ?? resolveBlueBubblesConfig
          )();
          const live = await resolveLive(
            {
              ...configured,
              baseUrl: control?.activeBaseUrl || configured.baseUrl || null,
            },
            intent.targetLabel,
          );
          // A completed live lookup may confirm a contact, or establish that an
          // exact stored 1:1 is not represented in Contacts. Conflicting exact
          // identities remain ambiguous and cannot dispatch.
          recipientResolution = mergeBlueBubblesRecipientTruth(stored, live);
        } catch (error) {
          // Directory/configuration failure is different from a successful
          // directory miss. Never fall back to stored identity during outage.
          recipientResolution = { state: 'missing' };
          params.onRecipientLookupFailure?.(error);
        }
      }
    } else {
      recipientResolution = resolveStored(intent.targetLabel);
      if (intent.mode !== 'execute') {
        try {
          const configured = (
            params.resolveConfig ?? resolveBlueBubblesConfig
          )();
          const live = await resolveLive(
            {
              ...configured,
              baseUrl: control?.activeBaseUrl || configured.baseUrl || null,
            },
            intent.targetLabel,
          );
          if (live.state !== 'missing') recipientResolution = live;
        } catch (error) {
          params.onRecipientLookupFailure?.(error);
        }
      }
    }
  }

  const request: ExecuteBlueBubblesOutboundRequestParams = {
    groupFolder: params.groupFolder,
    channel: params.channel,
    chatJid: params.chatJid,
    group: params.group,
    ownerAuthored: params.ownerAuthored,
    rawText: params.rawText,
    inboundMessageId: params.inboundMessageId,
    recipientResolution,
    now: params.now,
    capabilityFacts,
    executionDeps: params.executionDeps,
    capabilityRegistry: registry,
  };

  if (!binding) {
    const evaluation = registry.evaluate(
      {
        capabilityId: intent.capabilityId,
        action: 'send',
        sourceChannel: params.channel,
      },
      capabilityFacts,
    );
    return {
      handled: true,
      state:
        evaluation.state === 'available'
          ? 'unavailable_capability'
          : evaluation.state,
      replyText: `Andrea: ${
        formatRuntimeCapabilityEvaluation(evaluation) ||
        'The registered execution binding is unavailable. I did not dispatch anything.'
      }`,
    };
  }

  return (await binding.execute(
    request,
  )) as ExecuteBlueBubblesOutboundRequestResult;
}
