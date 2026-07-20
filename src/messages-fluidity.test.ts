import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { runCouncilMock } = vi.hoisted(() => ({
  runCouncilMock: vi.fn(),
}));

vi.mock('./provider-council-runner.js', () => ({
  runObservableProviderCouncil: runCouncilMock,
}));

import {
  draftBlueBubblesCommunicationReply,
  resolveBlueBubblesReplyGateMode,
  summarizeBlueBubblesThreadDigest,
} from './messages-fluidity.js';

const originalFetch = globalThis.fetch;

describe('messages fluidity', () => {
  beforeEach(() => {
    vi.stubEnv(
      'BLUEBUBBLES_CANONICAL_SELF_THREAD_JID',
      'iMessage;-;+12025550199',
    );
    vi.stubEnv('BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS', 'iMessage;-;+12025550199');
    runCouncilMock.mockReset();
    runCouncilMock.mockResolvedValue(null);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('treats the BlueBubbles self-thread as conversational 1:1 mode', () => {
    expect(
      resolveBlueBubblesReplyGateMode({
        chatJid: 'bb:iMessage;-;+12025550199',
        isGroup: false,
      }),
    ).toBe('direct_1to1');
    expect(
      resolveBlueBubblesReplyGateMode({
        chatJid: 'bb:iMessage;-;+12025550101',
        isGroup: false,
      }),
    ).toBe('mention_required');
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
    expect(result.providerAttempted).toBe(true);
    expect(result.councilAttempted).toBe(false);
  });

  it('records a requested council provider review even when visible synthesis falls back locally', async () => {
    vi.stubEnv('OPENAI_API_KEY', ' ');
    runCouncilMock.mockResolvedValue({
      structuredVerdict: { usableMemberCount: 1 },
    });

    const result = await summarizeBlueBubblesThreadDigest({
      chatName: 'Pops of Punk',
      windowLabel: 'today',
      transcript: 'Alex: The set list still needs review.',
      channel: 'telegram',
      thinkingMode: 'deep',
    });

    expect(runCouncilMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      source: 'fallback',
      providerAttempted: false,
      councilAttempted: true,
      councilProviderUsed: true,
    });
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

  it('rejects invented amounts and timing even when the surrounding topic overlaps', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    vi.stubEnv('OPENAI_MODEL_STANDARD', 'gpt-5.4');
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            output_text: JSON.stringify({
              lead: 'The rent payment is the main topic.',
              digest:
                'The rent payment of $2,500 is due friday and should be handled soon.',
              bullets: ['Pay $2,500 by friday.'],
              suggestedReplies: [],
            }),
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    ) as typeof fetch;

    const result = await summarizeBlueBubblesThreadDigest({
      chatName: 'Housing',
      windowLabel: 'this week',
      transcript: 'Someone: The rent payment still needs attention.',
      channel: 'telegram',
    });

    expect(result).toMatchObject({
      source: 'fallback',
      fallbackReason: 'ungrounded',
    });
  });

  it('rejects a digest when one of several visible bullets is unsupported', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    vi.stubEnv('OPENAI_MODEL_STANDARD', 'gpt-5.4');
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            output_text: JSON.stringify({
              lead: 'Dinner address and Fallout worldbuilding were discussed.',
              digest:
                'The messages covered the dinner address and Fallout worldbuilding.',
              bullets: [
                'The dinner address remains an open question.',
                "Fallout worldbuilding is Friday's topic.",
                'The discussion centered on garden renovation plans.',
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
        '[Conversation: Candace]\nCandace: Can you send the dinner address?\n\n[Conversation: Pops of Punk]\nAlex: Fallout worldbuilding is our topic Friday.',
      channel: 'telegram',
      thinkingMode: 'quick',
    });

    expect(result).toMatchObject({
      source: 'fallback',
      fallbackReason: 'ungrounded',
      providerAttempted: true,
    });
    expect(result.bullets).toEqual([]);
  });

  it('rejects a mixed digest when one otherwise anchored claim removes evidence negation', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    vi.stubEnv('OPENAI_MODEL_STANDARD', 'gpt-5.4');
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            output_text: JSON.stringify({
              lead: 'The dinner plan and pickup schedule are the main topics.',
              digest:
                'The dinner plan is confirmed, and the pickup remains scheduled.',
              bullets: [
                'The pickup remains scheduled.',
                'The dinner plan is confirmed.',
              ],
              suggestedReplies: [],
            }),
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    ) as typeof fetch;

    const result = await summarizeBlueBubblesThreadDigest({
      chatName: 'Plans',
      windowLabel: 'today',
      transcript:
        'Someone: The dinner plan is not confirmed. Someone: The pickup remains scheduled.',
      channel: 'telegram',
    });

    expect(result).toMatchObject({
      source: 'fallback',
      fallbackReason: 'ungrounded',
      providerAttempted: true,
    });
    expect(result.bullets).toEqual([]);
  });

  it('accepts a concise model draft that stays anchored to the supplied message', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    vi.stubEnv('OPENAI_MODEL_STANDARD', 'gpt-5.4');
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            output_text: JSON.stringify({
              draftText: 'Thanks — I got the package.',
            }),
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    ) as typeof fetch;

    const result = await draftBlueBubblesCommunicationReply({
      messageText: 'The package arrived.',
      summaryText: 'The package arrived.',
      style: 'balanced',
    });

    expect(result).toEqual({
      draftText: 'Thanks — I got the package.',
      source: 'openai',
    });
  });

  it.each([
    {
      label: 'an unsupported owner answer',
      messageText: 'Can you let me know if dinner works tonight?',
      summaryText: 'They asked whether dinner works tonight.',
      draftText: 'Yes, dinner works for me tonight.',
    },
    {
      label: 'invented person, amount, and day',
      messageText: 'The package arrived.',
      summaryText: 'The package arrived.',
      draftText: 'I paid Jordan $2,500 Friday for the package.',
    },
    {
      label: 'an unsupported future promise',
      messageText: 'The package arrived.',
      summaryText: 'The package arrived.',
      draftText: "Thanks, I'll confirm the package tomorrow.",
    },
  ])('rejects $label in a model-written draft', async (fixture) => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    vi.stubEnv('OPENAI_MODEL_STANDARD', 'gpt-5.4');
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            output_text: JSON.stringify({ draftText: fixture.draftText }),
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    ) as typeof fetch;

    const result = await draftBlueBubblesCommunicationReply({
      messageText: fixture.messageText,
      summaryText: fixture.summaryText,
      style: 'balanced',
    });

    expect(result).toMatchObject({
      draftText: null,
      source: 'fallback',
    });
    expect(result.fallbackNote).toContain('unsupported details');
  });

  it('rejects a draft that turns a negated state into an asserted state', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    vi.stubEnv('OPENAI_MODEL_STANDARD', 'gpt-5.4');
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            output_text: JSON.stringify({
              draftText: 'Thanks — the dinner plan is confirmed.',
            }),
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    ) as typeof fetch;

    const result = await draftBlueBubblesCommunicationReply({
      messageText: 'The dinner plan is not confirmed.',
      summaryText: 'The dinner plan is not confirmed.',
      style: 'balanced',
    });

    expect(result).toMatchObject({
      draftText: null,
      source: 'fallback',
    });
    expect(result.fallbackNote).toContain('unsupported details');
  });
});
