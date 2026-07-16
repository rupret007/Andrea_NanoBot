import { afterEach, describe, expect, it, vi } from 'vitest';

import {
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
        chatJid: 'bb:iMessage;-;+12025550101',
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
    vi.stubEnv('ANDREA_OPENAI_BACKEND_ENABLED', 'true');
    vi.resetModules();
    const { interpretBlueBubblesDirectTurn } =
      await import('./messages-fluidity.js');
    globalThis.fetch = vi.fn(
      async () =>
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
      chatJid: 'bb:iMessage;-;+12025550101',
      text: 'can you make that a little warmer?',
    });

    expect(result.source).toBe('openai');
    expect(result.routeFamily).toBe('message_action_followup');
    expect(result.assistantPrompt).toBe('make it warmer');
  });

  it('returns an honest fallback envelope when the OpenAI lane is unavailable', async () => {
    vi.stubEnv('ANDREA_OPENAI_BACKEND_ENABLED', 'true');
    vi.resetModules();
    const { interpretBlueBubblesDirectTurn } =
      await import('./messages-fluidity.js');
    globalThis.fetch = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED');
    }) as typeof fetch;

    const result = await interpretBlueBubblesDirectTurn({
      groupFolder: 'main',
      chatJid: 'bb:iMessage;-;+12025550101',
      text: 'what do you think?',
    });

    expect(result.source).toBe('fallback');
    expect(result.fallbackText).toContain("I'm here");
  });

  it('reuses a completed routing attempt instead of calling the backend twice', async () => {
    vi.stubEnv('ANDREA_OPENAI_BACKEND_ENABLED', 'true');
    vi.resetModules();
    const { interpretBlueBubblesDirectTurn } =
      await import('./messages-fluidity.js');
    const fetchSpy = vi.fn(async () => {
      throw new Error('duplicate backend request');
    });
    globalThis.fetch = fetchSpy as typeof fetch;

    const result = await interpretBlueBubblesDirectTurn({
      groupFolder: 'main',
      chatJid: 'bb:iMessage;-;+12025550101',
      text: 'can you make that a little warmer?',
      routingResult: {
        decision: {
          routeKind: 'assistant_capability',
          capabilityId: 'communication.manage_tracking',
          canonicalText: 'make it warmer',
          arguments: { replyStyle: 'warmer' },
          confidence: 'high',
          clarificationPrompt: null,
          reason: 'matched draft rewrite follow-up',
        },
        source: 'openai_router',
      },
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      source: 'openai',
      routeFamily: 'message_action_followup',
      assistantPrompt: 'make it warmer',
    });
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
            lead: 'Fallout, its world, and repeated material were the main points.',
            digest:
              'People compared whether Fallout can stay true to its world without simply replaying the same material.',
            bullets: [
              'One person said Fallout keeps the world right.',
              'Another did not want the same material repeated.',
              'The latest turn liked the Fallout story but did not know the world well.',
            ],
            suggestedReplies: [
              {
                label: 'warm',
                text: 'I like that framing. I think Fallout works best when it keeps the world intact without just replaying the same plot.',
              },
              {
                label: 'brief',
                text: 'Yeah, that is why Fallout works for me: same world, new story.',
              },
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
    expect(result.lead).toContain('repeated material');
    expect(result.digest).toContain('Fallout can stay true');
    expect(result.bullets).toHaveLength(3);
    expect(result.suggestedReplies).toEqual([
      {
        label: 'warm',
        text: 'I like that framing. I think Fallout works best when it keeps the world intact without just replaying the same plot.',
      },
      {
        label: 'brief',
        text: 'Yeah, that is why Fallout works for me: same world, new story.',
      },
    ]);
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

  it('rejects a cross-chat digest that swaps facts between named conversations', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    vi.stubEnv('OPENAI_MODEL_STANDARD', 'gpt-5.4');
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            output_text: JSON.stringify({
              lead: 'Candace and Pops of Punk covered dinner and Fallout.',
              digest:
                'Candace agreed to use Fallout for Friday, while Pops of Punk asked for the dinner address.',
              bullets: [
                'Candace settled the Fallout topic.',
                'Pops of Punk still needs the dinner address.',
              ],
              suggestedReplies: [],
            }),
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    ) as typeof fetch;

    const result = await summarizeBlueBubblesThreadDigest({
      chatName: 'all synced Messages chats',
      windowLabel: 'today',
      transcript:
        '[Conversation: Candace]\nCandace: Can you send me the dinner address?\n\n[Conversation: Pops of Punk]\nAlex: We agreed to discuss Fallout on Friday.',
      channel: 'telegram',
      thinkingMode: 'quick',
    });

    expect(result).toMatchObject({
      source: 'fallback',
      fallbackReason: 'ungrounded',
    });
  });
});
