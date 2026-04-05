import { describe, expect, it, vi } from 'vitest';

import {
  BlueBubblesChannel,
  buildBlueBubblesHealthSnapshot,
  createBlueBubblesWebhookAdapter,
  normalizeBlueBubblesIncomingMessage,
  resolveBlueBubblesConfig,
} from './bluebubbles.js';

describe('BlueBubbles channel prep', () => {
  it('resolves config with safe disabled-by-default behavior', () => {
    const config = resolveBlueBubblesConfig({
      BLUEBUBBLES_ENABLED: 'false',
      BLUEBUBBLES_BASE_URL: 'https://blue.example.com/',
      BLUEBUBBLES_PASSWORD: 'secret',
      BLUEBUBBLES_WEBHOOK_PATH: '/bluebubbles/incoming',
      BLUEBUBBLES_WEBHOOK_SECRET: 'hook-secret',
      BLUEBUBBLES_SEND_ENABLED: 'false',
    });

    expect(config.enabled).toBe(false);
    expect(config.baseUrl).toBe('https://blue.example.com');
    expect(config.webhookPath).toBe('/bluebubbles/incoming');
    expect(config.webhookSecret).toBe('hook-secret');
    expect(config.sendEnabled).toBe(false);
  });

  it('normalizes a webhook payload into the shared NewMessage shape', () => {
    const normalized = normalizeBlueBubblesIncomingMessage({
      type: 'new-message',
      data: {
        guid: 'msg-1',
        chatGuid: 'chat-1',
        chat: {
          guid: 'chat-1',
          displayName: 'Candace',
          participants: [{ address: '+15551234567' }],
        },
        message: {
          guid: 'msg-1',
          text: 'Hey, can you call me later?',
          senderName: 'Candace',
          handle: {
            address: '+15551234567',
            displayName: 'Candace',
          },
          dateCreated: '2026-04-05T12:00:00.000Z',
        },
      },
    });

    expect(normalized).not.toBeNull();
    expect(normalized?.chatJid).toBe('bb:chat-1');
    expect(normalized?.message.sender).toBe('bb:+15551234567');
    expect(normalized?.message.content).toBe('Hey, can you call me later?');
  });

  it('feeds normalized webhook messages through the shared adapter callbacks', async () => {
    const onMessage = vi.fn();
    const onChatMetadata = vi.fn();
    const adapter = createBlueBubblesWebhookAdapter({
      onMessage,
      onChatMetadata,
    });

    const message = await adapter({
      type: 'message.new',
      data: {
        chatGuid: 'chat-2',
        chat: {
          guid: 'chat-2',
          displayName: 'Band chat',
          isGroup: true,
        },
        message: {
          guid: 'msg-2',
          body: 'Rehearsal is at 7.',
          senderName: 'Chris',
          handle: { address: '+15557654321', displayName: 'Chris' },
          dateCreated: '2026-04-05T13:00:00.000Z',
        },
      },
    });

    expect(message?.chat_jid).toBe('bb:chat-2');
    expect(onChatMetadata).toHaveBeenCalledWith(
      'bb:chat-2',
      '2026-04-05T13:00:00.000Z',
      'Band chat',
      'bluebubbles',
      true,
    );
    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it('keeps outbound sends disabled and only claims bb: chats', async () => {
    const channel = new BlueBubblesChannel(
      {
        enabled: true,
        baseUrl: 'https://blue.example.com',
        password: 'secret',
        webhookPath: '/bluebubbles/webhook',
        webhookSecret: 'hook-secret',
        sendEnabled: false,
      },
      {
        onMessage: vi.fn(),
        onChatMetadata: vi.fn(),
        registeredGroups: () => ({}),
        onHealthUpdate: vi.fn(),
      },
    );

    await channel.connect();
    expect(channel.isConnected()).toBe(true);
    expect(channel.ownsJid('bb:chat-1')).toBe(true);
    expect(channel.ownsJid('tg:chat-1')).toBe(false);
    await expect(channel.sendMessage('bb:chat-1', 'hello')).rejects.toThrow(
      'disabled',
    );
  });

  it('reports receive-first health when enabled without outbound sends', () => {
    const snapshot = buildBlueBubblesHealthSnapshot({
      enabled: true,
      baseUrl: 'https://blue.example.com',
      password: 'secret',
      webhookPath: '/bluebubbles/webhook',
      webhookSecret: 'hook-secret',
      sendEnabled: false,
    });

    expect(snapshot.configured).toBe(true);
    expect(snapshot.state).toBe('ready');
    expect(snapshot.detail).toContain('receive-first mode');
  });
});
