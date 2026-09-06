import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import {
  buildAssistantCapabilityExecutionInput,
  hasCompleteCommunicationForgetInput,
  isExactConfirmedCommunicationTrackingPresentation,
  resolveCommunicationTrackingPresentation,
  shouldRetireCommunicationForgetContext,
} from './assistant-capability-input.js';
import type { AssistantCapabilityResult } from './assistant-capabilities.js';
import { authorizeCognitiveReplyDelivery } from './cognitive-kernel.js';
import { resolveCognitiveDeliveryPayload } from './cognitive-runtime-completion.js';

describe('buildAssistantCapabilityExecutionInput', () => {
  it('does not inherit the prior thread target for generic synced-thread summary asks', () => {
    const result = buildAssistantCapabilityExecutionInput({
      lastContent: 'Summarize my text messages for today',
      capabilityMatch: {
        capabilityId: 'communication.summarize_thread',
        canonicalText: 'Summarize my text messages for today',
      },
      priorSubjectData: {
        threadTitle: 'Pops of Punk',
        personName: 'Pops of Punk',
      },
    });

    expect(result.threadTitle).toBeNull();
    expect(result.personName).toBeUndefined();
    expect(result.timeWindowKind).toBeNull();
  });

  it('keeps explicit thread targets on named synced-thread summary asks', () => {
    const result = buildAssistantCapabilityExecutionInput({
      lastContent:
        'Summarize the texts today from the Pops of Punk text thread please',
      capabilityMatch: {
        capabilityId: 'communication.summarize_thread',
        canonicalText: 'summarize my text messages in Pops of Punk from today',
        arguments: {
          targetChatName: 'Pops of Punk',
          threadTitle: 'Pops of Punk',
          timeWindowKind: 'today',
          timeWindowValue: null,
        },
      },
      priorSubjectData: {
        threadTitle: 'Older thread',
      },
    });

    expect(result.targetChatName).toBe('Pops of Punk');
    expect(result.threadTitle).toBe('Pops of Punk');
    expect(result.timeWindowKind).toBe('today');
  });

  it('does not inherit the prior thread target for recent text review asks', () => {
    const result = buildAssistantCapabilityExecutionInput({
      lastContent: 'Review my recent texts',
      capabilityMatch: {
        capabilityId: 'communication.review_recent_texts',
        canonicalText: 'review recent text messages from the last 24 hours',
      },
      priorSubjectData: {
        threadTitle: 'Candace',
        personName: 'Candace',
      },
    });

    expect(result.threadTitle).toBeNull();
    expect(result.personName).toBeUndefined();
  });

  it('still reuses prior communication context for other communication follow-ups', () => {
    const result = buildAssistantCapabilityExecutionInput({
      lastContent: 'What should I say back?',
      capabilityMatch: {
        capabilityId: 'communication.draft_reply',
        canonicalText: 'what should I say back',
      },
      priorSubjectData: {
        threadTitle: 'Candace',
        personName: 'Candace',
      },
    });

    expect(result.threadTitle).toBe('Candace');
    expect(result.personName).toBe('Candace');
  });

  it('does not inherit leftover person titles for generic what-do-I-owe asks', () => {
    const result = buildAssistantCapabilityExecutionInput({
      lastContent: 'What do I owe people?',
      capabilityMatch: {
        capabilityId: 'communication.open_loops',
        canonicalText: 'what do I owe people',
      },
      priorSubjectData: {
        threadTitle: 'Bob',
        personName: 'Bob',
      },
    });

    expect(result.threadTitle).toBeNull();
    expect(result.personName).toBeUndefined();
    expect(result.targetChatName).toBeNull();
  });

  it('keeps an explicit named who-do-I-owe target', () => {
    const result = buildAssistantCapabilityExecutionInput({
      lastContent: "What's still open with Bob?",
      capabilityMatch: {
        capabilityId: 'communication.open_loops',
        canonicalText: "what's still open with Bob",
        arguments: {
          targetChatName: 'Bob',
          threadTitle: 'Bob',
          personName: 'Bob',
        },
      },
      priorSubjectData: {
        threadTitle: 'Older thread',
        personName: 'Older thread',
      },
    });

    expect(result.targetChatName).toBe('Bob');
    expect(result.threadTitle).toBe('Bob');
    expect(result.personName).toBe('Bob');
  });
});

describe('typed local tracking presentation boundary', () => {
  function result(kind: 'review' | 'forget_status'): AssistantCapabilityResult {
    const text =
      kind === 'review'
        ? 'One synthetic conversation needs a reply: Riley asked for the rehearsal address.'
        : 'Removed this local tracking record. Original messages and reminders remain.';
    return {
      handled: true,
      capabilityId:
        kind === 'review'
          ? 'communication.open_loops'
          : 'communication.manage_tracking',
      replyText: text,
      communicationTrackingPresentation: { kind, text },
      conversationSeed:
        kind === 'review'
          ? {
              flowKey: 'communication_open_loops',
              subjectKind: 'communication_thread',
              summaryText: text,
              guidanceGoal: 'action_follow_through',
              subjectData: {
                communicationForgetReviewJson: '{"fixture":"review"}',
              },
            }
          : undefined,
    };
  }

  it.each(['review', 'forget_status'] as const)(
    'preserves exact typed %s through the real cognitive delivery gate without authorizing a general completion',
    (kind) => {
      const local = result(kind);
      const presentation = resolveCommunicationTrackingPresentation(local);
      expect(presentation).toMatchObject({
        kind,
        text: local.replyText,
        replyKind: 'progress',
        preserveStructuredText: true,
      });
      const authorization = authorizeCognitiveReplyDelivery({
        cognitiveRun: null,
        replyKind: presentation!.replyKind,
      });
      const payload = resolveCognitiveDeliveryPayload({
        authorization,
        requestedText: local.replyText!,
      });
      expect(authorization.allowed).toBe(true);
      expect(authorization.completionAuthorized).toBe(false);
      expect(payload.text).toBe(local.replyText);
      expect(
        isExactConfirmedCommunicationTrackingPresentation({
          authorizationAllowed: authorization.allowed,
          requestedText: local.replyText!,
          deliveredText: payload.text,
          deliveryOutcome: 'confirmed',
        }),
      ).toBe(true);

      const genericAuthorization = authorizeCognitiveReplyDelivery({
        cognitiveRun: null,
        replyKind: 'completion',
      });
      const genericPayload = resolveCognitiveDeliveryPayload({
        authorization: genericAuthorization,
        requestedText: local.replyText!,
      });
      expect(genericAuthorization.allowed).toBe(false);
      expect(genericPayload.text).not.toBe(local.replyText);
      expect(
        isExactConfirmedCommunicationTrackingPresentation({
          authorizationAllowed: genericAuthorization.allowed,
          requestedText: local.replyText!,
          deliveredText: genericPayload.text,
          deliveryOutcome: 'confirmed',
        }),
      ).toBe(false);
    },
  );

  it('does not upgrade missing, mismatched, unbound, or unrelated result markers', () => {
    const review = result('review');
    for (const unsafe of [
      { ...review, handled: false },
      { ...review, communicationTrackingPresentation: undefined },
      { ...review, replyText: 'A different or substituted message.' },
      { ...review, conversationSeed: undefined },
      { ...review, capabilityId: 'communication.draft_reply' as const },
      { ...review, capabilityId: 'communication.manage_tracking' as const },
    ]) {
      expect(resolveCommunicationTrackingPresentation(unsafe)).toBeUndefined();
    }
  });

  it('never treats a changed, denied, partial, unknown, or rejected presentation as review authority', () => {
    const text = result('review').replyText!;
    for (const deliveryOutcome of ['partial', 'unknown', 'rejected'] as const) {
      expect(
        isExactConfirmedCommunicationTrackingPresentation({
          authorizationAllowed: true,
          requestedText: text,
          deliveredText: text,
          deliveryOutcome,
        }),
      ).toBe(false);
    }
    expect(
      isExactConfirmedCommunicationTrackingPresentation({
        authorizationAllowed: false,
        requestedText: text,
        deliveredText: text,
        deliveryOutcome: 'confirmed',
      }),
    ).toBe(false);
    expect(
      isExactConfirmedCommunicationTrackingPresentation({
        authorizationAllowed: true,
        requestedText: text,
        deliveredText: 'A substituted evaluator response.',
        deliveryOutcome: 'confirmed',
      }),
    ).toBe(false);
  });

  it('wires exact confirmed presentation and receipt withholding into the real send path', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    const sender = source.slice(
      source.indexOf('const sendAssistantReplyWithFeedback = async'),
      source.indexOf('const sendCognitiveTurnReply ='),
    );
    const transportGate = sender.indexOf(
      "if (delivery.deliveryOutcome !== 'confirmed')",
    );
    const confirmation = sender.indexOf(
      'params.onExactConfirmedPresentation?.(',
    );
    expect(transportGate).toBeGreaterThan(0);
    expect(confirmation).toBeGreaterThan(transportGate);
    expect(sender.slice(transportGate, confirmation)).toContain(
      'throw new CommittedIncompleteDeliveryError(',
    );
    expect(sender.slice(confirmation)).toMatch(
      /authorizationAllowed: deliveryAuthorization.allowed,[\s\S]*requestedText: params.text,[\s\S]*deliveredText: replyText,[\s\S]*deliveryOutcome: delivery.deliveryOutcome,/,
    );
    expect(sender).toContain(
      'params.preserveStructuredText && deliveryAuthorization.allowed',
    );
    const shared = source.slice(
      source.indexOf('const tryHandleSharedAssistantCapability = async'),
      source.indexOf('const tryHandleOpenAiGuidedReply = async'),
    );
    const withholding = shared.indexOf(
      'delete result.conversationSeed.subjectData.communicationForgetReviewJson;',
    );
    const presentation = shared.indexOf(
      "replyKind: trackingPresentation?.replyKind || 'completion'",
    );
    const restoration = shared.indexOf('=\n          pendingTrackingReview;');
    const persisted = shared.indexOf(
      'setSharedAssistantCapabilitySeed(chatJid, result.conversationSeed, now);',
    );
    expect(withholding).toBeGreaterThan(0);
    expect(presentation).toBeGreaterThan(withholding);
    expect(restoration).toBeGreaterThan(presentation);
    expect(persisted).toBeGreaterThan(restoration);
    expect(shared).toContain(
      'preserveStructuredText: trackingPresentation?.preserveStructuredText',
    );
    expect(shared).toContain(
      "presented && trackingPresentation.kind === 'review'",
    );
    expect(shared).toMatch(
      /pendingTrackingReview &&\s*trackingReviewPresented &&/,
    );
  });

  it('keeps callback, self-thread, and replayed complete-forget language out of delegation and priming', () => {
    for (const rawText of [
      '@OpenClaw forget this conversation thread completely',
      '/openclaw forget this conversation thread completely',
      'ask OpenClaw to forget this conversation thread completely',
      'do not forget this conversation thread completely',
    ]) {
      expect(hasCompleteCommunicationForgetInput({ rawText })).toBe(true);
    }
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    expect(source).toMatch(
      /const queuedOpenClawRoute = queuedCompleteForget\s*\? \{ action: 'none' as const \}\s*: resolveOpenClawDelegationRoute\(/,
    );
    const callback = source.slice(
      source.indexOf(
        'onMessage: async (chatJid: string, msg: NewMessage) => {',
      ),
    );
    const gate = callback.indexOf('if (callbackCompleteForget) {');
    expect(gate).toBeGreaterThan(
      callback.indexOf('isBlueBubblesDataOnlyContactThread({'),
    );
    expect(gate).toBeGreaterThan(
      callback.indexOf('shouldDropIncomingMessageBeforeCommands('),
    );
    expect(gate).toBeGreaterThan(callback.indexOf('if (msg.reaction) {'));
    expect(
      callback.indexOf('const openClawRoute = resolveOpenClawDelegationRoute('),
    ).toBeGreaterThan(gate);
    expect(callback.indexOf('const agiConfirmMatch =')).toBeGreaterThan(gate);
    const body = callback.slice(
      gate,
      callback.indexOf('const agiConfirmMatch ='),
    );
    expect(body).toContain('storeMessage(msg);');
    expect(body).toContain('if (trustedInboundOwnerSurface) {');
    expect(body).toContain('queue.enqueueMessageCheck(chatJid);');
    expect(body).toContain('complete_forget_rejected_non_owner');
    expect(body).toContain('return;');
    const selfGate = callback.indexOf('if (selfThreadCompleteForget) {');
    expect(selfGate).toBeGreaterThan(gate);
    expect(callback.indexOf('const selfThreadOpenClawRoute =')).toBeGreaterThan(
      selfGate,
    );
    expect(
      callback.indexOf('const primed = await primeBlueBubblesChatHistory('),
    ).toBeGreaterThan(selfGate);
  });
});

describe('complete-forget raw ingress binding', () => {
  const command = 'forget this conversation thread completely';

  it.each([
    `do not ${command}`,
    `"${command}"`,
    `${command} and remind me later`,
    `${command}?`,
    `@Andrea ${command}`,
  ])(
    'retains the exact inbound body when a mocked interpreter rewrites %s',
    (raw) => {
      const interpret = vi.fn((_text: string) => command);
      const result = buildAssistantCapabilityExecutionInput({
        rawLastContent: raw,
        lastContent: interpret(raw),
        capabilityMatch: {
          capabilityId: 'communication.manage_tracking',
          canonicalText: command,
        },
      });
      expect(interpret).toHaveBeenCalledWith(raw);
      expect(result.rawText).toBe(raw);
      expect(result.text).toBe(command);
      expect(result.canonicalText).toBe(command);
      expect(hasCompleteCommunicationForgetInput(result)).toBe(true);
    },
  );

  it('never substitutes a rewritten command for an explicitly empty raw body', () => {
    const result = buildAssistantCapabilityExecutionInput({
      rawLastContent: '',
      lastContent: command,
      capabilityMatch: {
        capabilityId: 'communication.manage_tracking',
        canonicalText: command,
      },
    });
    expect(result.rawText).toBe('');
    expect(hasCompleteCommunicationForgetInput(result)).toBe(true);
  });

  it('detects a raw mention removed by rewriting, or a destructive canonical invention', () => {
    expect(
      hasCompleteCommunicationForgetInput({
        rawText: `do not ${command}`,
        text: 'stop tracking that',
        canonicalText: 'stop tracking that',
      }),
    ).toBe(true);
    const result = buildAssistantCapabilityExecutionInput({
      rawLastContent: 'What can you do with this conversation?',
      lastContent: 'What can you do with this conversation?',
      capabilityMatch: {
        capabilityId: 'communication.manage_tracking',
        canonicalText: command,
      },
    });
    expect(result.rawText).toBe('What can you do with this conversation?');
    expect(hasCompleteCommunicationForgetInput(result)).toBe(true);
    expect(
      hasCompleteCommunicationForgetInput({ text: 'stop tracking that' }),
    ).toBe(false);
  });

  it('retires handled success and refusal before a confirmation delivery can fail', async () => {
    for (const rawText of [command, `do not ${command}`]) {
      let seed: string | undefined = 'old summary and destructive review';
      const input = { rawText, text: command, canonicalText: command };
      const deliver = vi.fn(async () => {
        expect(seed).toBeUndefined();
        throw new Error('Synthetic delivery failure');
      });
      if (
        shouldRetireCommunicationForgetContext({
          input,
          handled: true,
          capabilityId: 'communication.manage_tracking',
        })
      ) {
        seed = undefined;
      }
      await expect(deliver()).rejects.toThrow('Synthetic delivery failure');
      expect(seed).toBeUndefined();
    }
    expect(
      shouldRetireCommunicationForgetContext({
        input: { text: command },
        handled: false,
        capabilityId: 'communication.manage_tracking',
      }),
    ).toBe(false);
    expect(
      shouldRetireCommunicationForgetContext({
        input: { text: 'stop tracking that' },
        handled: true,
        capabilityId: 'communication.manage_tracking',
      }),
    ).toBe(false);
  });

  it('keeps the actual ingress gate ahead of mutating handlers and uses immutable raw input', () => {
    // Read source only: importing index would start unrelated application runtime.
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    const rawIngress = source.indexOf(
      "const rawLastContent = latestUserMessage?.content ?? '';",
    );
    const rawGateDecision = source.search(
      /hasCompleteCommunicationForgetInput\(\s*\{\s*rawText: rawLastContent\s*\},?\s*\)/,
    );
    expect(rawIngress).toBeGreaterThan(0);
    expect(rawGateDecision).toBeGreaterThan(rawIngress);
    expect(
      source.indexOf(
        'normalizeBlueBubblesCompanionPrompt(rawLastContent)',
        rawIngress,
      ),
    ).toBeGreaterThan(rawGateDecision);
    const gate = source.indexOf('if (shouldHandleCompleteForgetLocally) {');
    expect(gate).toBeGreaterThan(0);
    const gateBody = source.slice(
      gate,
      source.indexOf('if (await tryHandleLocalCalendarAutomation())', gate),
    );
    expect(gateBody).toContain(
      'return await tryHandleSharedAssistantCapability();',
    );
    expect(gateBody).toContain('clearSharedAssistantCapabilitySeed(chatJid);');
    for (const nextHandler of [
      'tryHandleLocalCalendarAutomation',
      'tryHandleLocalGoogleCalendarFollowThrough',
      'tryHandleLocalGoogleCalendarCreate',
      'tryHandleOutcomeReview',
      'tryHandleMessageActionFollowup',
      'tryHandleActionBundleFollowup',
      'tryHandleSharedAssistantCompletion',
    ]) {
      expect(source.indexOf(`if (await ${nextHandler}())`)).toBeGreaterThan(
        gate,
      );
    }
    const shared = source.slice(
      source.indexOf('const tryHandleSharedAssistantCapability = async'),
      source.indexOf('const tryHandleOpenAiGuidedReply = async'),
    );
    expect(shared).toMatch(
      /shouldHandleCompleteForgetLocally\s*\? matchAssistantCapabilityRequest\(rawLastContent\)/,
    );
    expect(shared).toMatch(
      /buildAssistantCapabilityExecutionInput\(\{\s*lastContent,\s*rawLastContent,/,
    );
    const afterExecution = shared.slice(
      shared.indexOf('result = await executeAssistantCapability('),
    );
    const retire = afterExecution.indexOf(
      'shouldRetireCommunicationForgetContext(',
    );
    const clear = afterExecution.indexOf(
      'clearSharedAssistantCapabilitySeed(chatJid);',
    );
    expect(retire).toBeGreaterThan(0);
    expect(clear).toBeGreaterThan(retire);
    expect(
      afterExecution.indexOf('await sendAssistantReplyWithFeedback('),
    ).toBeGreaterThan(clear);
    expect(source).toMatch(
      /const preHarnessMessageActionOperation =\s*!shouldHandleCompleteForgetLocally &&/,
    );
    expect(source).toMatch(
      /const turnAgentHarness: TurnAgentHarnessContext \| null =\s*shouldHandleCompleteForgetLocally \|\|/,
    );
    expect(shared).toMatch(
      /!shouldHandleCompleteForgetLocally &&\s*isCognitiveExecutiveCandidate\(lastContent\)/,
    );
  });
});
