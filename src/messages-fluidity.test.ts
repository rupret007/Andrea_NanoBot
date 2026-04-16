import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  interpretBlueBubblesDirectTurn,
  resolveBlueBubblesReplyGateMode,
  summarizeBlueBubblesThreadDigest,
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
    globalThis.fetch = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED');
    }) as typeof fetch;

    const result = await interpretBlueBubblesDirectTurn({
      groupFolder: 'main',
      chatJid: 'bb:iMessage;-;+14695405551',
      text: 'what do you think?',
    });

    expect(result.source).toBe('fallback');
    expect(result.fallbackText).toContain("I'm here");
  });

  it('uses the standard tier for synced thread digest synthesis', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    vi.stubEnv('OPENAI_MODEL_STANDARD', 'gpt-5.4');
    globalThis.fetch = vi.fn(async (_input, init) => {
      const payload = JSON.parse(String(init?.body)) as {
        model: string;
      };
      expect(payload.model).toBe('gpt-5.4');
      return new Response(
        JSON.stringify({
          output_text: JSON.stringify({
            lead: 'The thread mostly debated how faithful an adaptation should be.',
            digest:
              'People compared Fallout and Invincible as examples of when a story can stay true to the world without simply replaying the same material.',
            bullets: [
              'One person liked Fallout as a continuation story.',
              'Another pushed against simple retellings.',
              'The latest turn landed on liking the story but not knowing the wider world as well.',
            ],
          }),
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch;

    const result = await summarizeBlueBubblesThreadDigest({
      chatName: 'Pops of Punk',
      windowLabel: 'today',
      transcript:
        'One person: Fallout works because it keeps the world right.\nAnother person: I do not want the same material repeated.\nOne person: I like the Fallout story but I do not know the world too well.',
      channel: 'telegram',
    });

    expect(result.source).toBe('openai');
    expect(result.lead).toContain('adaptation');
    expect(result.digest).toContain('Fallout and Invincible');
    expect(result.bullets).toHaveLength(3);
  });

  it('falls back promptly when synced thread digest synthesis times out', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    globalThis.fetch = vi.fn((_input, init) => {
      const signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        if (!signal) {
          reject(new Error('Expected an abortable request signal.'));
          return;
        }
        signal.addEventListener(
          'abort',
          () => reject(new DOMException('Timed out', 'TimeoutError')),
          { once: true },
        );
      });
    }) as typeof fetch;

    const result = await summarizeBlueBubblesThreadDigest({
      chatName: 'Pops of Punk',
      windowLabel: 'today',
      transcript:
        'One person: Fallout works because it keeps the world right.\nAnother person: I do not want the same material repeated.',
      channel: 'telegram',
      timeoutMs: 100,
    });

    expect(result.source).toBe('fallback');
    expect(result.fallbackNote).toContain('grounded locally');
  });
});
