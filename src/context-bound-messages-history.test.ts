import { describe, expect, it, vi } from 'vitest';

import { resolveRefreshedContextBoundRecipient } from './context-bound-messages-history.js';

const target = {
  chatJid: 'bb:iMessage;-;+12025550123',
  displayName: 'Avery Example',
  isGroup: false,
};

describe('context-bound Messages history', () => {
  it('refreshes an exact known quiet thread and rejects context made stale outside the global newest slice', async () => {
    let messages = [
      {
        id: 'pickup-request',
        content: 'Could you pick them up after school?',
        timestamp: '2026-04-07T20:00:00.000Z',
        is_from_me: false,
        is_bot_message: false,
      },
    ];
    const primeRecentHistory = vi.fn(async () => {
      throw new Error('the global newest slice must not gate a known thread');
    });
    const primeChatHistory = vi.fn(async (chatJid: string) => {
      expect(chatJid).toBe(target.chatJid);
      messages = [
        {
          id: 'pickup-cancelled',
          content: 'Never mind, I already handled the ride.',
          timestamp: '2026-04-07T20:05:00.000Z',
          is_from_me: false,
          is_bot_message: false,
        },
      ];
    });
    const listRecentMessagesForChat = vi.fn(() => messages);

    const result = await resolveRefreshedContextBoundRecipient({
      targetLabel: 'Avery Example',
      replyContent: 'Ask if she could pick them up.',
      resolveRecipient: () => ({ state: 'resolved', target }),
      primeRecentHistory,
      primeChatHistory,
      listRecentMessagesForChat,
    });

    expect(result).toMatchObject({
      state: 'context_stale',
      target,
      latestInbound: {
        content: 'Never mind, I already handled the ride.',
      },
    });
    expect(primeRecentHistory).not.toHaveBeenCalled();
    expect(primeChatHistory).toHaveBeenCalledOnce();
    expect(listRecentMessagesForChat).toHaveBeenCalledTimes(2);
    expect(
      listRecentMessagesForChat.mock.invocationCallOrder[1],
    ).toBeGreaterThan(primeChatHistory.mock.invocationCallOrder[0]!);
  });

  it('rejects an ordinary contextual yes when an unrelated closure arrives during exact-thread refresh', async () => {
    let messages = [
      {
        id: 'dinner-question',
        content: 'Does seven work for dinner?',
        timestamp: '2026-04-07T20:00:00.000Z',
        is_from_me: false,
        is_bot_message: false,
      },
    ];

    const result = await resolveRefreshedContextBoundRecipient({
      targetLabel: 'Avery Example',
      replyContent: 'Tell her yes.',
      resolveRecipient: () => ({ state: 'resolved', target }),
      primeRecentHistory: vi.fn(),
      primeChatHistory: vi.fn(async () => {
        messages = [
          {
            id: 'dinner-cancelled',
            content: 'Never mind, dinner is already handled.',
            timestamp: '2026-04-07T20:02:00.000Z',
            is_from_me: false,
            is_bot_message: false,
          },
        ];
      }),
      listRecentMessagesForChat: () => messages,
    });

    expect(result).toMatchObject({
      state: 'context_stale',
      latestInbound: { id: 'dinner-cancelled' },
    });
  });

  it('rejects an edited latest inbound even when the provider reuses its message id', async () => {
    let messages = [
      {
        id: 'mutable-provider-id',
        content: 'Can you bring dessert?',
        timestamp: '2026-04-07T20:00:00.000Z',
        is_from_me: false,
        is_bot_message: false,
      },
    ];

    const result = await resolveRefreshedContextBoundRecipient({
      targetLabel: 'Avery Example',
      replyContent: 'Tell her yes.',
      resolveRecipient: () => ({ state: 'resolved', target }),
      primeRecentHistory: vi.fn(),
      primeChatHistory: vi.fn(async () => {
        messages = [
          {
            id: 'mutable-provider-id',
            content: 'Never mind, dessert is covered.',
            timestamp: '2026-04-07T20:00:00.000Z',
            is_from_me: false,
            is_bot_message: false,
          },
        ];
      }),
      listRecentMessagesForChat: () => messages,
    });

    expect(result).toMatchObject({
      state: 'context_stale',
      latestInbound: {
        id: 'mutable-provider-id',
        content: 'Never mind, dessert is covered.',
      },
    });
  });

  it('fails closed after capturing but never acting on stale local context when exact-thread refresh fails', async () => {
    const refreshError = new Error('targeted history unavailable');
    const listRecentMessagesForChat = vi.fn(() => [
      {
        content: 'Old locally cached message.',
        is_from_me: false,
        is_bot_message: false,
      },
    ]);

    const result = await resolveRefreshedContextBoundRecipient({
      targetLabel: 'Avery Example',
      replyContent: 'Tell her yes.',
      resolveRecipient: () => ({ state: 'resolved', target }),
      primeRecentHistory: vi.fn(),
      primeChatHistory: vi.fn(async () => {
        throw refreshError;
      }),
      listRecentMessagesForChat,
    });

    expect(result).toEqual({
      state: 'targeted_refresh_failed',
      target,
      error: refreshError,
    });
    expect(listRecentMessagesForChat).toHaveBeenCalledOnce();
  });

  it('uses broad history only to discover metadata, then refreshes the resolved exact thread', async () => {
    let discovered = false;
    const primeRecentHistory = vi.fn(async () => {
      discovered = true;
    });
    const primeChatHistory = vi.fn();

    const result = await resolveRefreshedContextBoundRecipient({
      targetLabel: 'Avery Example',
      replyContent: 'Tell her yes.',
      resolveRecipient: () =>
        discovered ? { state: 'resolved', target } : { state: 'missing' },
      primeRecentHistory,
      primeChatHistory,
      listRecentMessagesForChat: () => [
        {
          id: 'dinner-question',
          content: 'Does seven work?',
          timestamp: '2026-04-07T20:00:00.000Z',
          is_from_me: false,
          is_bot_message: false,
        },
      ],
    });

    expect(result).toMatchObject({
      state: 'resolved',
      recipientResolution: { state: 'resolved', target },
    });
    expect(primeRecentHistory).toHaveBeenCalledOnce();
    expect(primeChatHistory).toHaveBeenCalledWith(target.chatJid);
  });
});
