import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  interpretBlueBubblesDirectTurn,
  resolveBlueBubblesReplyGateMode,
} from './messages-fluidity.js';

const originalFetch = globalThis.fetch;

describe('messages fluidity', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('treats the BlueBubbles self-thread as conversational 1:1 mode', () => {
    expect(
      resolveBlueBubblesReplyGateMode({
        chatJid: 'bb:iMessage;-;+14695405551',
        isGroup: false,
      }),
    ).toBe('direct_1to1');
    expect(
      resolveBlueBubblesReplyGateMode({
        chatJid: 'bb:iMessage;+;chat-family',
        isGroup: true,
      }),
    ).toBe('mention_required');
  });

  it('interprets a direct BlueBubbles turn through the OpenAI lane when available', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          routeKind: 'assistant_capability',
          capabilityId: 'communication.manage_tracking',
          canonicalText: 'make it warmer',
          arguments: {
            replyStyle: 'warmer',
          },
          confidence: 'high',
          clarificationPrompt: null,
          reason: 'matched draft rewrite follow-up',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    ) as typeof fetch;

    const result = await interpretBlueBubblesDirectTurn({
      groupFolder: 'main',
      chatJid: 'bb:iMessage;-;+14695405551',
      text: 'can you make that a little warmer?',
    });

    expect(result.source).toBe('openai');
    expect(result.routeFamily).toBe('message_action_followup');
    expect(result.assistantPrompt).toBe('make it warmer');
  });

  it('returns an honest fallback envelope when the OpenAI lane is unavailable', async () => {
    const result = await interpretBlueBubblesDirectTurn({
      groupFolder: 'main',
      chatJid: 'bb:iMessage;-;+14695405551',
      text: 'what do you think?',
    });

    expect(result.source).toBe('fallback');
    expect(result.fallbackText).toContain("I'm here");
  });
});
