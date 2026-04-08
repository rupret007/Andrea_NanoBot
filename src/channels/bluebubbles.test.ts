import http from 'http';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _initTestDatabase,
  listRecentMessagesForChat,
  storeChatMetadata,
  storeMessage,
} from '../db.js';
import type { BlueBubblesConfig } from '../types.js';
import {
  BlueBubblesChannel,
  buildBlueBubblesHealthSnapshot,
  buildBlueBubblesWebhookUrl,
  inspectBlueBubblesWebhookRegistration,
  isBlueBubblesChatEligible,
  normalizeBlueBubblesIncomingMessage,
  primeBlueBubblesChatHistory,
  redactBlueBubblesWebhookUrl,
  resolveBlueBubblesConfig,
} from './bluebubbles.js';

async function startBlueBubblesApiStub(
  handler: (
    req: http.IncomingMessage,
    body: string,
    res: http.ServerResponse,
  ) => void | Promise<void>,
): Promise<{
  baseUrl: string;
  close(): Promise<void>;
}> {
  const server = http.createServer(async (req, res) => {
    if (
      (req.method || 'GET').toUpperCase() === 'GET' &&
      (req.url || '').startsWith('/api/v1/ping')
    ) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ status: 200, message: 'Ping received!', data: 'pong' }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    await handler(req, Buffer.concat(chunks).toString('utf8'), res);
  });
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  );
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to resolve BlueBubbles stub address');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

function buildConfig(
  overrides: Partial<BlueBubblesConfig> = {},
): BlueBubblesConfig {
  return {
    enabled: true,
    baseUrl: 'http://127.0.0.1:9999',
    password: 'secret',
    host: '127.0.0.1',
    port: 0,
    groupFolder: 'main',
    webhookPublicBaseUrl: null,
    chatScope: 'allowlist',
    allowedChatGuids: ['chat-1'],
    allowedChatGuid: 'chat-1',
    webhookPath: '/bluebubbles/webhook',
    webhookSecret: 'hook-secret',
    sendEnabled: true,
    ...overrides,
  };
}

describe('BlueBubbles channel', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
  });

  it('resolves config with the live V1 BlueBubbles fields', () => {
    const config = resolveBlueBubblesConfig({
      BLUEBUBBLES_ENABLED: 'true',
      BLUEBUBBLES_BASE_URL: 'https://blue.example.com/',
      BLUEBUBBLES_PASSWORD: 'secret',
      BLUEBUBBLES_HOST: '0.0.0.0',
      BLUEBUBBLES_PORT: '4315',
      BLUEBUBBLES_GROUP_FOLDER: 'main',
      BLUEBUBBLES_WEBHOOK_PUBLIC_BASE_URL: 'http://192.168.5.136:4305',
      BLUEBUBBLES_CHAT_SCOPE: 'all_synced',
      BLUEBUBBLES_ALLOWED_CHAT_GUIDS: 'chat-1,chat-2',
      BLUEBUBBLES_ALLOWED_CHAT_GUID: 'chat-1',
      BLUEBUBBLES_WEBHOOK_PATH: '/bluebubbles/incoming',
      BLUEBUBBLES_WEBHOOK_SECRET: 'hook-secret',
      BLUEBUBBLES_SEND_ENABLED: 'false',
    });

    expect(config).toMatchObject({
      enabled: true,
      baseUrl: 'https://blue.example.com',
      host: '0.0.0.0',
      port: 4315,
      groupFolder: 'main',
      webhookPublicBaseUrl: 'http://192.168.5.136:4305',
      chatScope: 'all_synced',
      allowedChatGuids: ['chat-1', 'chat-2'],
      allowedChatGuid: 'chat-1',
      webhookPath: '/bluebubbles/incoming',
      webhookSecret: 'hook-secret',
      sendEnabled: false,
    });
  });

  it('builds a public webhook URL separately from the bind listener', () => {
    expect(
      buildBlueBubblesWebhookUrl(
        buildConfig({
          host: '0.0.0.0',
          port: 4305,
          webhookPublicBaseUrl: 'http://192.168.5.136:4305',
        }),
      ),
    ).toBe('http://192.168.5.136:4305/bluebubbles/webhook?secret=hook-secret');
  });

  it('redacts the webhook secret in operator-visible BlueBubbles URLs', () => {
    expect(
      redactBlueBubblesWebhookUrl(
        'http://192.168.5.136:4305/bluebubbles/webhook?secret=hook-secret',
      ),
    ).toBe('http://192.168.5.136:4305/bluebubbles/webhook?secret=***');
  });

  it('detects when Andrea webhook registration is present on the live server', async () => {
    const apiStub = await startBlueBubblesApiStub(async (req, _body, res) => {
      if ((req.url || '').startsWith('/api/v1/webhook')) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            data: [
              {
                id: 7,
                url: 'http://192.168.5.136:4305/bluebubbles/webhook?secret=hook-secret',
                events: ['new-message'],
              },
            ],
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end('not found');
    });

    try {
      const inspection = await inspectBlueBubblesWebhookRegistration(
        buildConfig({
          baseUrl: apiStub.baseUrl,
          webhookPublicBaseUrl: 'http://192.168.5.136:4305',
        }),
      );

      expect(inspection.state).toBe('registered');
      expect(inspection.detail).toContain('registered on the BlueBubbles server');
      expect(inspection.webhookId).toBe(7);
    } finally {
      await apiStub.close();
    }
  });

  it('supports all-synced, contacts-only, and allowlist chat scope checks', () => {
    expect(
      isBlueBubblesChatEligible(
        buildConfig({ chatScope: 'all_synced' }),
        'iMessage;+;chat-1',
        true,
      ),
    ).toBe(true);
    expect(
      isBlueBubblesChatEligible(
        buildConfig({ chatScope: 'contacts_only' }),
        'iMessage;+;chat-1',
        false,
      ),
    ).toBe(true);
    expect(
      isBlueBubblesChatEligible(
        buildConfig({ chatScope: 'contacts_only' }),
        'iMessage;+;chat-1',
        true,
      ),
    ).toBe(false);
    expect(
      isBlueBubblesChatEligible(
        buildConfig({
          chatScope: 'allowlist',
          allowedChatGuids: ['chat-2'],
          allowedChatGuid: null,
        }),
        'chat-2',
      ),
    ).toBe(true);
  });

  it('normalizes reply context into the shared bb: message id space', () => {
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
          replyToGuid: 'msg-0',
          dateCreated: '2026-04-05T12:00:00.000Z',
        },
      },
    });

    expect(normalized?.message.reply_to_id).toBe('bb:msg-0');
  });

  it('normalizes the live BlueBubbles webhook payload shape with chats and handle fields', () => {
    const normalized = normalizeBlueBubblesIncomingMessage({
      type: 'new-message',
      data: {
        guid: 'msg-live-1',
        text: '@Andrea summarize this',
        dateCreated: '2026-04-08T04:41:18.909Z',
        isFromMe: false,
        handle: {
          address: '+15551234567',
          displayName: 'Candace',
          service: 'iMessage',
        },
        chats: [
          {
            guid: 'iMessage;+;chat463000721308415525',
            displayName: 'Candace',
            isGroup: false,
            chatIdentifier: '+15551234567',
            lastAddressedHandle: 'candace@example.com',
            participants: [{ address: '+15551234567' }],
          },
        ],
      },
    });

    expect(normalized).toEqual(
      expect.objectContaining({
        chatJid: 'bb:iMessage;+;chat463000721308415525',
        chat: expect.objectContaining({
          chatGuid: 'iMessage;+;chat463000721308415525',
          displayName: 'Candace',
          isGroup: false,
          chatIdentifier: '+15551234567',
          lastAddressedHandle: 'candace@example.com',
          service: 'iMessage',
        }),
        contact: expect.objectContaining({
          address: '+15551234567',
          service: 'iMessage',
        }),
        message: expect.objectContaining({
          id: 'bb:msg-live-1',
          sender: 'bb:+15551234567',
          sender_name: 'Candace',
          content: '@Andrea summarize this',
          is_from_me: false,
        }),
      }),
    );
  });

  it('accepts a signed inbound webhook once and suppresses duplicate delivery', async () => {
    const apiStub = await startBlueBubblesApiStub(async (_req, _body, res) => {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: { guid: 'server-msg-1' } }));
    });

    const onMessage = vi.fn(async (_chatJid, message) => {
      storeMessage(message);
    });
    const onChatMetadata = vi.fn(
      async (chatJid: string, timestamp: string, name?: string, channel?: string, isGroup?: boolean) => {
        storeChatMetadata(chatJid, timestamp, name, channel, isGroup);
      },
    );
    const onHealthUpdate = vi.fn();
    const channel = new BlueBubblesChannel(
      buildConfig({ baseUrl: apiStub.baseUrl }),
      {
        onMessage,
        onChatMetadata,
        registeredGroups: () => ({}),
        onHealthUpdate,
      },
    );

    try {
      await channel.connect();
      const webhookUrl = channel.getWebhookUrl();
      const payload = {
        type: 'new-message',
        data: {
          chatGuid: 'chat-1',
          chat: {
            guid: 'chat-1',
            displayName: 'Candace',
            participants: [{ address: '+15551234567' }],
          },
          message: {
            guid: 'msg-1',
            body: 'What am I forgetting?',
            senderName: 'Candace',
            handle: { address: '+15551234567', displayName: 'Candace' },
            dateCreated: '2026-04-05T13:00:00.000Z',
          },
        },
      };

      const first = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const second = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      expect(first.status).toBe(200);
      expect(second.status).toBe(202);
      expect(onChatMetadata).toHaveBeenCalledTimes(1);
      expect(onMessage).toHaveBeenCalledTimes(1);
      expect(onMessage).toHaveBeenCalledWith(
        'bb:chat-1',
        expect.objectContaining({
          id: 'bb:msg-1',
          content: 'What am I forgetting?',
        }),
      );
    } finally {
      await channel.disconnect();
      await apiStub.close();
    }
  });

  it('hydrates direct-chat metadata from history and caches the first successful self-chat target', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const historyRequests: string[] = [];
    const healthDetails: string[] = [];
    const apiStub = await startBlueBubblesApiStub(async (req, body, res) => {
      if ((req.url || '').startsWith('/api/v1/webhook')) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            data: [
              {
                id: 1,
                url: 'http://127.0.0.1:0/bluebubbles/webhook?secret=hook-secret',
                events: ['new-message'],
              },
            ],
          }),
        );
        return;
      }
      if ((req.url || '').startsWith('/api/v1/server/info')) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            data: {
              private_api: false,
            },
          }),
        );
        return;
      }
      if ((req.url || '').startsWith('/api/v1/chat/')) {
        historyRequests.push(req.url || '');
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            data: [
              {
                guid: 'hist-self-1',
                text: '@Andrea Hi',
                isFromMe: true,
                service: 'iMessage',
                chatIdentifier: '+14695405551',
                lastAddressedHandle: 'jeffstory007@gmail.com',
                handle: {
                  address: '+14695405551',
                  displayName: 'Jeff',
                  service: 'iMessage',
                },
                chats: [
                  {
                    guid: 'iMessage;-;+14695405551',
                    chatIdentifier: '+14695405551',
                    lastAddressedHandle: 'jeffstory007@gmail.com',
                    service: 'iMessage',
                    isGroup: false,
                    participants: [{ address: '+14695405551' }],
                  },
                ],
              },
            ],
          }),
        );
        return;
      }
      const parsed = JSON.parse(body) as Record<string, unknown>;
      requests.push(parsed);
      if (parsed.chatGuid === 'iMessage;-;+14695405551') {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Message Send Error' }));
        return;
      }
      if (parsed.chatGuid === 'any;-;jeffstory007@gmail.com') {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Message Send Error' }));
        return;
      }
      if (parsed.chatGuid === 'iMessage;-;jeffstory007@gmail.com') {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ data: { guid: `server-msg-${requests.length}` } }));
        return;
      }
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: `unexpected target ${String(parsed.chatGuid || 'none')}` }));
    });

    const onMessage = vi.fn(async (_chatJid, message) => {
      storeMessage(message);
    });
    const channel = new BlueBubblesChannel(
      buildConfig({
        baseUrl: apiStub.baseUrl,
        chatScope: 'all_synced',
        allowedChatGuids: [],
        allowedChatGuid: null,
      }),
      {
        onMessage,
        onChatMetadata: vi.fn(async (chatJid, timestamp, name, channelName, isGroup) => {
          storeChatMetadata(chatJid, timestamp, name, channelName, isGroup);
        }),
        registeredGroups: () => ({}),
        onHealthUpdate: vi.fn((snapshot) => {
          healthDetails.push(snapshot.detail || '');
        }),
      },
    );

    try {
      await channel.connect();
      const inbound = await fetch(channel.getWebhookUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'new-message',
          data: {
            chatGuid: 'iMessage;-;+14695405551',
            chat: {
              guid: 'iMessage;-;+14695405551',
              displayName: 'Jeff',
              isGroup: false,
              chatIdentifier: '+14695405551',
              participants: [{ address: '+14695405551' }],
            },
            message: {
              guid: 'msg-self-1',
              body: '@Andrea hi',
              senderName: 'Jeff',
              handle: {
                address: '+14695405551',
                displayName: 'Jeff',
                service: 'iMessage',
              },
              isFromMe: true,
              dateCreated: '2026-04-08T05:16:43.059Z',
            },
          },
        }),
      });

      expect(inbound.status).toBe(200);
      expect(
        (channel as any)['buildOutboundTargetCandidates'](
          'bb:iMessage;-;+14695405551',
          'iMessage;-;+14695405551',
        ),
      ).toEqual([
        { kind: 'chat_guid', chatGuid: 'iMessage;-;+14695405551' },
        { kind: 'chat_identifier', chatGuid: 'any;-;+14695405551' },
      ]);

      const first = await channel.sendMessage(
        'bb:iMessage;-;+14695405551',
        'Hi. I am here.',
      );
      const second = await channel.sendMessage(
        'bb:iMessage;-;+14695405551',
        'Still here.',
      );

      expect(first.platformMessageId).toBe('bb:server-msg-3');
      expect(second.platformMessageId).toBe('bb:server-msg-4');
      expect(historyRequests).toHaveLength(1);
      expect(historyRequests[0]).toContain(
        '/api/v1/chat/iMessage%3B-%3B%2B14695405551/message',
      );
      expect(requests.map((request) => request.chatGuid)).toEqual([
        'iMessage;-;+14695405551',
        'any;-;jeffstory007@gmail.com',
        'iMessage;-;jeffstory007@gmail.com',
        'iMessage;-;jeffstory007@gmail.com',
      ]);
      expect(requests.every((request) => request.method === 'apple-script')).toBe(
        true,
      );
      expect(
        requests.every(
          (request) =>
            typeof request.tempGuid === 'string' &&
            (request.tempGuid as string).length > 10,
        ),
      ).toBe(true);
      expect(
        (channel as any)['buildOutboundTargetCandidates'](
          'bb:iMessage;-;+14695405551',
          'iMessage;-;+14695405551',
        ),
      ).toEqual([
        {
          kind: 'service_specific_last_addressed_handle',
          chatGuid: 'iMessage;-;jeffstory007@gmail.com',
        },
        { kind: 'chat_guid', chatGuid: 'iMessage;-;+14695405551' },
        { kind: 'last_addressed_handle', chatGuid: 'any;-;jeffstory007@gmail.com' },
        { kind: 'chat_identifier', chatGuid: 'any;-;+14695405551' },
      ]);
      expect(
        healthDetails.some((detail) =>
          detail.includes('last metadata hydration history'),
        ),
      ).toBe(true);
      expect(
        healthDetails.some((detail) =>
          detail.includes('send method apple-script'),
        ),
      ).toBe(true);
      expect(
        healthDetails.some((detail) =>
          detail.includes('private api available no'),
        ),
      ).toBe(true);
      expect(
        healthDetails.some((detail) =>
          detail.includes(
            'attempted target sequence chat_guid -> last_addressed_handle -> service_specific_last_addressed_handle',
          ),
        ),
      ).toBe(true);
    } finally {
      await channel.disconnect();
      await apiStub.close();
    }
  });

  it('does not use the direct-chat fallback ladder for group chats', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const historyRequests: string[] = [];
    const apiStub = await startBlueBubblesApiStub(async (req, body, res) => {
      if ((req.url || '').startsWith('/api/v1/webhook')) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            data: [
              {
                id: 1,
                url: 'http://127.0.0.1:0/bluebubbles/webhook?secret=hook-secret',
                events: ['new-message'],
              },
            ],
          }),
        );
        return;
      }
      if ((req.url || '').startsWith('/api/v1/server/info')) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ data: { private_api: true } }));
        return;
      }
      if ((req.url || '').startsWith('/api/v1/chat/')) {
        historyRequests.push(req.url || '');
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ data: [] }));
        return;
      }
      requests.push(JSON.parse(body) as Record<string, unknown>);
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Message Send Error' }));
    });

    const channel = new BlueBubblesChannel(
      buildConfig({
        baseUrl: apiStub.baseUrl,
        chatScope: 'all_synced',
        allowedChatGuids: [],
        allowedChatGuid: null,
      }),
      {
        onMessage: vi.fn(),
        onChatMetadata: vi.fn(),
        registeredGroups: () => ({}),
        onHealthUpdate: vi.fn(),
      },
    );

    try {
      await channel.connect();
      await expect(
        channel.sendMessage('bb:iMessage;+;chat-group', 'Hi group.'),
      ).rejects.toThrow('BlueBubbles send failed after targets [chat_guid]');
      expect(requests).toHaveLength(1);
      expect(historyRequests).toHaveLength(0);
      expect(requests[0]?.chatGuid).toBe('iMessage;+;chat-group');
    } finally {
      await channel.disconnect();
      await apiStub.close();
    }
  });

  it('accepts a self-authored BlueBubbles message when it explicitly mentions @Andrea', async () => {
    const apiStub = await startBlueBubblesApiStub(async (_req, _body, res) => {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: { guid: 'server-msg-1' } }));
    });

    const onMessage = vi.fn(async (_chatJid, message) => {
      storeMessage(message);
    });
    const onChatMetadata = vi.fn(
      async (
        chatJid: string,
        timestamp: string,
        name?: string,
        channel?: string,
        isGroup?: boolean,
      ) => {
        storeChatMetadata(chatJid, timestamp, name, channel, isGroup);
      },
    );
    const channel = new BlueBubblesChannel(
      buildConfig({ baseUrl: apiStub.baseUrl, chatScope: 'all_synced' }),
      {
        onMessage,
        onChatMetadata,
        registeredGroups: () => ({}),
        onHealthUpdate: vi.fn(),
      },
    );

    try {
      await channel.connect();
      const response = await fetch(channel.getWebhookUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'new-message',
          data: {
            chatGuid: 'iMessage;+;chat-mention',
            chat: {
              guid: 'iMessage;+;chat-mention',
              displayName: 'Group Thread',
              isGroup: true,
              participants: [{ address: '+15551234567' }],
            },
            message: {
              guid: 'msg-self-mention',
              body: '@Andrea what am I forgetting?',
              senderName: 'Jeff',
              handle: { address: '+15550001111', displayName: 'Jeff' },
              isFromMe: true,
              dateCreated: '2026-04-08T05:10:00.000Z',
            },
          },
        }),
      });

      expect(response.status).toBe(200);
      expect(onMessage).toHaveBeenCalledTimes(1);
      expect(onMessage).toHaveBeenCalledWith(
        'bb:iMessage;+;chat-mention',
        expect.objectContaining({
          id: 'bb:msg-self-mention',
          content: '@Andrea what am I forgetting?',
          is_from_me: true,
        }),
      );
    } finally {
      await channel.disconnect();
      await apiStub.close();
    }
  });

  it('ignores self-authored BlueBubbles chatter without an @Andrea mention', async () => {
    const apiStub = await startBlueBubblesApiStub(async (_req, _body, res) => {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: { guid: 'server-msg-1' } }));
    });

    const onMessage = vi.fn();
    const onChatMetadata = vi.fn();
    const channel = new BlueBubblesChannel(
      buildConfig({ baseUrl: apiStub.baseUrl, chatScope: 'all_synced' }),
      {
        onMessage,
        onChatMetadata,
        registeredGroups: () => ({}),
        onHealthUpdate: vi.fn(),
      },
    );

    try {
      await channel.connect();
      const response = await fetch(channel.getWebhookUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'new-message',
          data: {
            chatGuid: 'iMessage;+;chat-mention',
            chat: {
              guid: 'iMessage;+;chat-mention',
              displayName: 'Group Thread',
              isGroup: true,
              participants: [{ address: '+15551234567' }],
            },
            message: {
              guid: 'msg-self-social',
              body: 'sounds good',
              senderName: 'Jeff',
              handle: { address: '+15550001111', displayName: 'Jeff' },
              isFromMe: true,
              dateCreated: '2026-04-08T05:11:00.000Z',
            },
          },
        }),
      });

      expect(response.status).toBe(202);
      expect(await response.text()).toBe('Ignored outgoing message without @Andrea mention');
      expect(onMessage).not.toHaveBeenCalled();
      expect(onChatMetadata).not.toHaveBeenCalled();
    } finally {
      await channel.disconnect();
      await apiStub.close();
    }
  });

  it('rejects secret mismatches and malformed payloads honestly', async () => {
    const apiStub = await startBlueBubblesApiStub(async (_req, _body, res) => {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: { guid: 'server-msg-1' } }));
    });
    const channel = new BlueBubblesChannel(
      buildConfig({ baseUrl: apiStub.baseUrl }),
      {
        onMessage: vi.fn(),
        onChatMetadata: vi.fn(),
        registeredGroups: () => ({}),
        onHealthUpdate: vi.fn(),
      },
    );

    try {
      await channel.connect();
      const wrongSecret = new URL(channel.getWebhookUrl());
      wrongSecret.searchParams.set('secret', 'nope');
      const unauthorized = await fetch(wrongSecret, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'new-message' }),
      });
      const malformed = await fetch(channel.getWebhookUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'new-message', data: {} }),
      });

      expect(unauthorized.status).toBe(401);
      expect(malformed.status).toBe(400);
    } finally {
      await channel.disconnect();
      await apiStub.close();
    }
  });

  it('sends a text reply back to the linked BlueBubbles conversation', async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const apiStub = await startBlueBubblesApiStub(async (req, body, res) => {
      if ((req.url || '').startsWith('/api/v1/webhook')) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            data: [
              {
                id: 1,
                url: 'http://127.0.0.1:0/bluebubbles/webhook?secret=hook-secret',
                events: ['new-message'],
              },
            ],
          }),
        );
        return;
      }
      if ((req.url || '').startsWith('/api/v1/server/info')) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ data: { private_api: true } }));
        return;
      }
      requests.push({
        url: req.url || '',
        body: JSON.parse(body) as Record<string, unknown>,
      });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: { guid: 'server-msg-7' } }));
    });

    const channel = new BlueBubblesChannel(
      buildConfig({ baseUrl: apiStub.baseUrl }),
      {
        onMessage: vi.fn(),
        onChatMetadata: vi.fn(),
        registeredGroups: () => ({}),
        onHealthUpdate: vi.fn(),
      },
    );

    try {
      await channel.connect();
      const result = await channel.sendMessage('bb:chat-1', 'Hello there.');

      expect(result.platformMessageId).toBe('bb:server-msg-7');
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toContain('/api/v1/message/text');
      expect(requests[0]?.url).toContain('guid=secret');
      expect(requests[0]?.url).toContain('password=secret');
      expect(requests[0]?.url).toContain('token=secret');
      expect(requests[0]?.body).toMatchObject({
        chatGuid: 'chat-1',
        message: 'Andrea: Hello there.',
        method: 'private-api',
      });
      expect(typeof requests[0]?.body.tempGuid).toBe('string');
      expect(listRecentMessagesForChat('bb:chat-1', 1)).toContainEqual(
        expect.objectContaining({
          id: 'bb:server-msg-7',
          content: 'Andrea: Hello there.',
          is_from_me: 1,
          is_bot_message: 1,
        }),
      );
    } finally {
      await channel.disconnect();
      await apiStub.close();
    }
  });

  it('keeps the BlueBubbles sender label idempotent and only prefixes the first line', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const apiStub = await startBlueBubblesApiStub(async (req, body, res) => {
      if ((req.url || '').startsWith('/api/v1/webhook')) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            data: [
              {
                id: 1,
                url: 'http://127.0.0.1:0/bluebubbles/webhook?secret=hook-secret',
                events: ['new-message'],
              },
            ],
          }),
        );
        return;
      }
      if ((req.url || '').startsWith('/api/v1/server/info')) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ data: { private_api: true } }));
        return;
      }
      requests.push(JSON.parse(body) as Record<string, unknown>);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: { guid: `server-msg-${requests.length}` } }));
    });

    const channel = new BlueBubblesChannel(
      buildConfig({ baseUrl: apiStub.baseUrl }),
      {
        onMessage: vi.fn(),
        onChatMetadata: vi.fn(),
        registeredGroups: () => ({}),
        onHealthUpdate: vi.fn(),
      },
    );

    try {
      await channel.connect();
      await channel.sendMessage('bb:chat-1', 'Andrea: Already labeled.');
      await channel.sendMessage('bb:chat-1', 'First line.\nSecond line.');

      expect(requests).toHaveLength(2);
      expect(requests[0]?.message).toBe('Andrea: Already labeled.');
      expect(requests[1]?.message).toBe('Andrea: First line.\nSecond line.');
      expect(listRecentMessagesForChat('bb:chat-1', 2)).toContainEqual(
        expect.objectContaining({
          id: 'bb:server-msg-2',
          content: 'Andrea: First line.\nSecond line.',
          is_bot_message: 1,
        }),
      );
      expect(listRecentMessagesForChat('bb:chat-1', 2)).toContainEqual(
        expect.objectContaining({
          id: 'bb:server-msg-1',
          content: 'Andrea: Already labeled.',
          is_bot_message: 1,
        }),
      );
    } finally {
      await channel.disconnect();
      await apiStub.close();
    }
  });

  it('falls back to a plain same-chat send when reply threading is rejected', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const apiStub = await startBlueBubblesApiStub(async (req, body, res) => {
      if ((req.url || '').startsWith('/api/v1/webhook')) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            data: [
              {
                id: 1,
                url: 'http://127.0.0.1:0/bluebubbles/webhook?secret=hook-secret',
                events: ['new-message'],
              },
            ],
          }),
        );
        return;
      }
      if ((req.url || '').startsWith('/api/v1/server/info')) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ data: { private_api: true } }));
        return;
      }
      const parsed = JSON.parse(body) as Record<string, unknown>;
      requests.push(parsed);
      if (parsed.selectedMessageGuid) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'reply target rejected' }));
        return;
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: { guid: 'server-msg-9' } }));
    });

    const channel = new BlueBubblesChannel(
      buildConfig({ baseUrl: apiStub.baseUrl }),
      {
        onMessage: vi.fn(),
        onChatMetadata: vi.fn(),
        registeredGroups: () => ({}),
        onHealthUpdate: vi.fn(),
      },
    );

    try {
      await channel.connect();
      const result = await channel.sendMessage('bb:chat-1', 'Andrea reply', {
        replyToMessageId: 'bb:msg-2',
      });

      expect(result.platformMessageId).toBe('bb:server-msg-9');
      expect(requests).toHaveLength(2);
      expect(requests[0]?.message).toBe('Andrea: Andrea reply');
      expect(requests[1]?.message).toBe('Andrea: Andrea reply');
      expect(requests[0]?.selectedMessageGuid).toBe('msg-2');
      expect(requests[1]?.selectedMessageGuid).toBeUndefined();
    } finally {
      await channel.disconnect();
      await apiStub.close();
    }
  });

  it('fails cleanly when outbound sends are disabled or receipts are missing', async () => {
    const noReceiptStub = await startBlueBubblesApiStub(async (_req, _body, res) => {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    });

    const disabled = new BlueBubblesChannel(
      buildConfig({ baseUrl: noReceiptStub.baseUrl, sendEnabled: false }),
      {
        onMessage: vi.fn(),
        onChatMetadata: vi.fn(),
        registeredGroups: () => ({}),
        onHealthUpdate: vi.fn(),
      },
    );
    const missingReceipt = new BlueBubblesChannel(
      buildConfig({ baseUrl: noReceiptStub.baseUrl }),
      {
        onMessage: vi.fn(),
        onChatMetadata: vi.fn(),
        registeredGroups: () => ({}),
        onHealthUpdate: vi.fn(),
      },
    );

    try {
      await disabled.connect();
      await missingReceipt.connect();
      await expect(disabled.sendMessage('bb:chat-1', 'hello')).rejects.toThrow(
        'disabled',
      );
      await expect(
        missingReceipt.sendMessage('bb:chat-1', 'hello'),
      ).rejects.toThrow('delivery receipt');
    } finally {
      await disabled.disconnect();
      await missingReceipt.disconnect();
      await noReceiptStub.close();
    }
  });

  it('reports degraded health when outbound reply-back is disabled', () => {
    const snapshot = buildBlueBubblesHealthSnapshot(
      buildConfig({ sendEnabled: false }),
    );

    expect(snapshot.configured).toBe(true);
    expect(snapshot.state).toBe('degraded');
    expect(snapshot.detail).toContain('outbound reply-back is disabled');
  });

  it('accepts all-synced inbound chats and can send to another scoped chat', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const apiStub = await startBlueBubblesApiStub(async (req, body, res) => {
      if ((req.url || '').startsWith('/api/v1/webhook')) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            data: [
              {
                id: 1,
                url: 'http://127.0.0.1:0/bluebubbles/webhook?secret=hook-secret',
                events: ['new-message'],
              },
            ],
          }),
        );
        return;
      }
      if ((req.url || '').startsWith('/api/v1/server/info')) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ data: { private_api: true } }));
        return;
      }
      requests.push(JSON.parse(body) as Record<string, unknown>);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: { guid: `server-msg-${requests.length}` } }));
    });

    const onMessage = vi.fn(async (_chatJid, message) => {
      storeMessage(message);
    });
    const channel = new BlueBubblesChannel(
      buildConfig({
        baseUrl: apiStub.baseUrl,
        chatScope: 'all_synced',
        allowedChatGuids: [],
        allowedChatGuid: null,
      }),
      {
        onMessage,
        onChatMetadata: vi.fn(async (chatJid, timestamp, name, channelName, isGroup) => {
          storeChatMetadata(chatJid, timestamp, name, channelName, isGroup);
        }),
        registeredGroups: () => ({}),
        onHealthUpdate: vi.fn(),
      },
    );

    try {
      await channel.connect();
      const inbound = await fetch(channel.getWebhookUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'new-message',
          data: {
            chatGuid: 'iMessage;+;chat-2',
            chat: {
              guid: 'iMessage;+;chat-2',
              displayName: 'Family',
              participants: [{ address: '+15551234567' }, { address: '+15557654321' }],
              isGroup: true,
            },
            message: {
              guid: 'msg-chat-2',
              body: '@Andrea hi',
              senderName: 'Candace',
              handle: { address: '+15551234567', displayName: 'Candace' },
              dateCreated: '2026-04-07T20:00:00.000Z',
            },
          },
        }),
      });
      const sendResult = await channel.sendMessage(
        'bb:iMessage;+;chat-2',
        'Hi. I am here.',
      );

      expect(inbound.status).toBe(200);
      expect(onMessage).toHaveBeenCalledWith(
        'bb:iMessage;+;chat-2',
        expect.objectContaining({
          id: 'bb:msg-chat-2',
          content: '@Andrea hi',
        }),
      );
      expect(sendResult.platformMessageId).toBe('bb:server-msg-1');
      expect(requests[0]?.chatGuid).toBe('iMessage;+;chat-2');
    } finally {
      await channel.disconnect();
      await apiStub.close();
    }
  });

  it('primes recent BlueBubbles chat history for @Andrea mentions', async () => {
    const apiStub = await startBlueBubblesApiStub(async (req, _body, res) => {
      if ((req.url || '').startsWith('/api/v1/chat/')) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            data: [
              {
                guid: 'hist-2',
                text: 'Can you send me the address when you get a chance?',
                senderName: 'Candace',
                handle: { address: '+15551234567', displayName: 'Candace' },
                dateCreated: '2026-04-07T20:00:00.000Z',
                isFromMe: false,
                chats: [
                  {
                    guid: 'iMessage;+;chat-2',
                    displayName: 'Candace',
                    isGroup: false,
                    participants: [{ address: '+15551234567' }],
                  },
                ],
              },
              {
                guid: 'hist-3',
                text: 'I can send it now.',
                senderName: 'Andrea',
                handle: { address: '+15550001111', displayName: 'Andrea' },
                dateCreated: '2026-04-07T20:01:00.000Z',
                isFromMe: true,
                chats: [
                  {
                    guid: 'iMessage;+;chat-2',
                    displayName: 'Candace',
                    isGroup: false,
                    participants: [{ address: '+15551234567' }],
                  },
                ],
              },
            ],
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end('not found');
    });

    try {
      const primed = await primeBlueBubblesChatHistory(
        buildConfig({ baseUrl: apiStub.baseUrl }),
        'bb:iMessage;+;chat-2',
        8,
      );

      expect(primed).toEqual({ storedCount: 2, totalCount: 2 });
      expect(listRecentMessagesForChat('bb:iMessage;+;chat-2', 4)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'bb:hist-2',
            content: 'Can you send me the address when you get a chance?',
          }),
          expect.objectContaining({
            id: 'bb:hist-3',
            content: 'I can send it now.',
          }),
        ]),
      );
    } finally {
      await apiStub.close();
    }
  });
});
