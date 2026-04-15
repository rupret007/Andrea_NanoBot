import http from 'http';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearBlueBubblesMonitorState,
  createDefaultBlueBubblesMonitorState,
  readBlueBubblesMonitorState,
  writeBlueBubblesMonitorState,
} from '../bluebubbles-monitor-state.js';
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
  const config: BlueBubblesConfig = {
    enabled: true,
    baseUrl: 'http://127.0.0.1:9999',
    baseUrlCandidates: ['http://127.0.0.1:9999'],
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
  if (!overrides.baseUrlCandidates) {
    config.baseUrlCandidates = config.baseUrl ? [config.baseUrl] : [];
  }
  return config;
}

describe('BlueBubbles channel', () => {
  beforeEach(() => {
    _initTestDatabase();
    clearBlueBubblesMonitorState();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    clearBlueBubblesMonitorState();
  });

  it('resolves config with the live V1 BlueBubbles fields', () => {
    const config = resolveBlueBubblesConfig({
      BLUEBUBBLES_ENABLED: 'true',
      BLUEBUBBLES_BASE_URL: 'https://blue.example.com/',
      BLUEBUBBLES_BASE_URL_CANDIDATES:
        'http://192.168.5.40:1234, https://blue-alt.example.com/',
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
      baseUrlCandidates: [
        'https://blue.example.com',
        'http://192.168.5.40:1234',
        'https://blue-alt.example.com',
      ],
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

  it('suppresses duplicate direct-turn delivery even when BlueBubbles changes the message guid', async () => {
    const apiStub = await startBlueBubblesApiStub(async (req, _body, res) => {
      if ((req.url || '').startsWith('/api/v1/webhook')) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ data: [] }));
        return;
      }
      if ((req.url || '').startsWith('/api/v1/server/info')) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ data: { private_api: true } }));
        return;
      }
      res.statusCode = 404;
      res.end('not found');
    });
    const onMessage = vi.fn(async (_chatJid, message) => {
      storeMessage(message);
    });
    const onChatMetadata = vi.fn(
      async (chatJid: string, timestamp: string, name?: string, channel?: string, isGroup?: boolean) => {
        storeChatMetadata(chatJid, timestamp, name, channel, isGroup);
      },
    );
    const channel = new BlueBubblesChannel(
      buildConfig({
        baseUrl: apiStub.baseUrl,
        chatScope: 'all_synced',
        allowedChatGuids: [],
        allowedChatGuid: null,
      }),
      {
        onMessage,
        onChatMetadata,
        registeredGroups: () => ({}),
        onHealthUpdate: vi.fn(),
      },
    );

    try {
      await channel.connect();
      const webhookUrl = channel.getWebhookUrl();
      const basePayload = {
        type: 'new-message',
        data: {
          chatGuid: 'iMessage;-;+14695405551',
          chat: {
            guid: 'iMessage;-;+14695405551',
            displayName: 'Jeff',
            participants: [{ address: '+14695405551' }],
            isGroup: false,
          },
          message: {
            body: '@Andrea help',
            senderName: 'Jeff',
            isFromMe: true,
            handle: { address: '+14695405551', displayName: 'Jeff' },
            dateCreated: '2026-04-12T20:08:00.000Z',
          },
        },
      };

      const first = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...basePayload,
          data: {
            ...basePayload.data,
            message: {
              ...basePayload.data.message,
              guid: 'duplicate-guid-a',
            },
          },
        }),
      });
      const second = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...basePayload,
          data: {
            ...basePayload.data,
            message: {
              ...basePayload.data.message,
              guid: 'duplicate-guid-b',
            },
          },
        }),
      });

      expect(first.status).toBe(200);
      expect(second.status).toBe(202);
      expect(onMessage).toHaveBeenCalledTimes(1);
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
      if (
        (req.method || 'GET').toUpperCase() === 'GET' &&
        (req.url || '').startsWith('/api/v1/message')
      ) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ data: [] }));
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
      expect(second.platformMessageId).toBe('bb:server-msg-5');
      expect(historyRequests).toHaveLength(1);
      expect(historyRequests[0]).toContain(
        '/api/v1/chat/iMessage%3B-%3B%2B14695405551/message',
      );
      expect(requests.map((request) => request.chatGuid)).toEqual([
        'iMessage;-;+14695405551',
        'any;-;jeffstory007@gmail.com',
        'iMessage;-;jeffstory007@gmail.com',
        'iMessage;-;+14695405551',
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
        { kind: 'chat_guid', chatGuid: 'iMessage;-;+14695405551' },
        {
          kind: 'service_specific_last_addressed_handle',
          chatGuid: 'iMessage;-;jeffstory007@gmail.com',
        },
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
      if (
        (req.method || 'GET').toUpperCase() === 'GET' &&
        (req.url || '').startsWith('/api/v1/message')
      ) {
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
      if (
        (req.method || 'GET').toUpperCase() === 'GET' &&
        (req.url || '').startsWith('/api/v1/message')
      ) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ data: [] }));
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
      if (
        (req.method || 'GET').toUpperCase() === 'GET' &&
        (req.url || '').startsWith('/api/v1/message')
      ) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ data: [] }));
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

  it('bypasses the Andrea label for approved external sends', async () => {
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
      if (
        (req.method || 'GET').toUpperCase() === 'GET' &&
        (req.url || '').startsWith('/api/v1/message')
      ) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ data: [] }));
        return;
      }
      requests.push({
        url: req.url || '',
        body: JSON.parse(body || '{}') as Record<string, unknown>,
      });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: { guid: 'server-msg-external-1' } }));
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
      await channel.sendMessage('bb:chat-1', 'Yes, tonight still works for me.', {
        suppressSenderLabel: true,
      });

      expect(requests[0]?.body).toMatchObject({
        chatGuid: 'chat-1',
        message: 'Yes, tonight still works for me.',
      });
      expect(listRecentMessagesForChat('bb:chat-1', 1)).toContainEqual(
        expect.objectContaining({
          id: 'bb:server-msg-external-1',
          content: 'Yes, tonight still works for me.',
          is_from_me: 1,
          is_bot_message: 0,
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
      if (
        (req.method || 'GET').toUpperCase() === 'GET' &&
        (req.url || '').startsWith('/api/v1/message')
      ) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ data: [] }));
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
      if (
        (req.method || 'GET').toUpperCase() === 'GET' &&
        (req.url || '').startsWith('/api/v1/message')
      ) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ data: [] }));
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

  it('marks newer 1:1 server activity as suspected missed inbound when Andrea never saw the webhook', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-12T20:10:00.000Z'));

    const apiStub = await startBlueBubblesApiStub(async (req, _body, res) => {
      if ((req.url || '').startsWith('/api/v1/webhook')) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ data: [] }));
        return;
      }
      if ((req.url || '').startsWith('/api/v1/server/info')) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ data: { private_api: true } }));
        return;
      }
      if ((req.url || '').startsWith('/api/v1/message')) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            data: [
              {
                guid: 'missed-msg-1',
                text: 'Are you there?',
                senderName: 'Jeff',
                handle: { address: '+14695550123', displayName: 'Jeff' },
                dateCreated: '2026-04-12T20:06:30.000Z',
                isFromMe: false,
                chats: [
                  {
                    guid: 'iMessage;-;+14695550123',
                    displayName: 'Jeff',
                    isGroup: false,
                    participants: [{ address: '+14695550123' }],
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

    const onHealthUpdate = vi.fn();
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
        onHealthUpdate,
      },
    );

    try {
      await channel.connect();

      const latestHealth = onHealthUpdate.mock.calls.at(-1)?.[0];
      expect(latestHealth?.detail).toContain(
        'detection suspected_missed_inbound',
      );
      expect(latestHealth?.detail).toContain('newer 1:1 chat activity');
      expect(latestHealth?.detail).toContain(
        'server seen chat bb:iMessage;-;+14695550123',
      );
      expect(latestHealth?.detail).toContain('fallback armed');
    } finally {
      await channel.disconnect();
      await apiStub.close();
    }
  });

  it('sends one Telegram fallback notice after repeated missed inbound evidence and then enters cooldown', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-12T20:10:00.000Z'));

    const onCrossSurfaceFallback = vi.fn(async () => ({
      sent: true,
      detail: 'sent fallback notice to tg:main',
    }));
    const apiStub = await startBlueBubblesApiStub(async (req, _body, res) => {
      if ((req.url || '').startsWith('/api/v1/webhook')) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ data: [] }));
        return;
      }
      if ((req.url || '').startsWith('/api/v1/server/info')) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ data: { private_api: true } }));
        return;
      }
      if (
        (req.method || 'GET').toUpperCase() === 'GET' &&
        (req.url || '').startsWith('/api/v1/message')
      ) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            data: [
              {
                guid: 'missed-msg-1',
                text: 'Checking in once',
                senderName: 'Jeff',
                handle: { address: '+14695550123', displayName: 'Jeff' },
                dateCreated: '2026-04-12T20:06:00.000Z',
                isFromMe: false,
                chats: [
                  {
                    guid: 'iMessage;-;+14695550123',
                    displayName: 'Jeff',
                    isGroup: false,
                    participants: [{ address: '+14695550123' }],
                  },
                ],
              },
              {
                guid: 'missed-msg-2',
                text: 'Checking in twice',
                senderName: 'Jeff',
                handle: { address: '+14695550123', displayName: 'Jeff' },
                dateCreated: '2026-04-12T20:07:00.000Z',
                isFromMe: false,
                chats: [
                  {
                    guid: 'iMessage;-;+14695550123',
                    displayName: 'Jeff',
                    isGroup: false,
                    participants: [{ address: '+14695550123' }],
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
        onCrossSurfaceFallback,
      },
    );

    try {
      await channel.connect();

      expect(onCrossSurfaceFallback).toHaveBeenCalledTimes(1);
      expect(onCrossSurfaceFallback).toHaveBeenCalledWith({
        sourceChannel: 'bluebubbles',
        detail: expect.stringContaining('newer 1:1 chat activity'),
        chatJid: 'bb:iMessage;-;+14695550123',
      });

      let monitorState = readBlueBubblesMonitorState();
      expect(monitorState.crossSurfaceFallbackState).toBe('sent');
      expect(monitorState.crossSurfaceFallbackLastSentAt).toBe(
        '2026-04-12T20:10:00.000Z',
      );

      vi.setSystemTime(new Date('2026-04-12T20:11:15.000Z'));
      await (channel as any).runShadowMonitorOnce();

      monitorState = readBlueBubblesMonitorState();
      expect(onCrossSurfaceFallback).toHaveBeenCalledTimes(1);
      expect(monitorState.crossSurfaceFallbackState).toBe('cooldown');
    } finally {
      await channel.disconnect();
      await apiStub.close();
    }
  });

  it('fails over to the first reachable BlueBubbles endpoint candidate', async () => {
    const apiStub = await startBlueBubblesApiStub(async (req, _body, res) => {
      if ((req.url || '').startsWith('/api/v1/webhook')) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ data: [] }));
        return;
      }
      if ((req.url || '').startsWith('/api/v1/server/info')) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ data: { private_api: true } }));
        return;
      }
      if ((req.url || '').startsWith('/api/v1/message')) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ data: [] }));
        return;
      }
      res.statusCode = 404;
      res.end('not found');
    });

    const channel = new BlueBubblesChannel(
      buildConfig({
        baseUrl: 'http://127.0.0.1:9',
        baseUrlCandidates: ['http://127.0.0.1:9', apiStub.baseUrl],
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

      const monitorState = readBlueBubblesMonitorState();
      expect(monitorState.activeBaseUrl).toBe(apiStub.baseUrl);
      expect(monitorState.candidateProbeResults['http://127.0.0.1:9']).toContain(
        'unreachable',
      );
      expect(monitorState.candidateProbeResults[apiStub.baseUrl]).toBe(
        'reachable/auth ok (200)',
      );
      expect(monitorState.detectionState).toBe('healthy');
    } finally {
      await channel.disconnect();
      await apiStub.close();
    }
  });

  it('keeps BlueBubbles health reporting alive when baseUrlCandidates is missing', async () => {
    const apiStub = await startBlueBubblesApiStub(async (req, _body, res) => {
      if ((req.url || '').startsWith('/api/v1/webhook')) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ data: [] }));
        return;
      }
      if ((req.url || '').startsWith('/api/v1/server/info')) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ data: { private_api: true } }));
        return;
      }
      if ((req.url || '').startsWith('/api/v1/message')) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ data: [] }));
        return;
      }
      res.statusCode = 404;
      res.end('not found');
    });

    const config = {
      ...buildConfig({
        baseUrl: apiStub.baseUrl,
        chatScope: 'all_synced',
        allowedChatGuids: [],
        allowedChatGuid: null,
      }),
      baseUrlCandidates: undefined,
    } as unknown as BlueBubblesConfig;

    const channel = new BlueBubblesChannel(config, {
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
      onHealthUpdate: vi.fn(),
    });

    try {
      await channel.connect();

      const monitorState = readBlueBubblesMonitorState();
      expect(monitorState.activeBaseUrl).toBe(apiStub.baseUrl);
      expect(monitorState.detectionState).toBe('healthy');
    } finally {
      await channel.disconnect();
      await apiStub.close();
    }
  });

  it('marks BlueBubbles transport as unreachable instead of healthy when the server cannot be polled', async () => {
    const channel = new BlueBubblesChannel(
      buildConfig({
        baseUrl: 'http://127.0.0.1:9',
        baseUrlCandidates: ['http://127.0.0.1:9'],
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

      const monitorState = readBlueBubblesMonitorState();
      expect(monitorState.detectionState).toBe('transport_unreachable');
      expect(monitorState.detectionDetail).toContain(
        'could not reach the BlueBubbles server',
      );
      expect(monitorState.crossSurfaceFallbackState).toBe('armed');
      expect(monitorState.activeBaseUrl).toBeNull();
    } finally {
      await channel.disconnect();
    }
  });

  it('re-probes candidates and refreshes readiness before outbound reply-back when the active endpoint goes stale', async () => {
    const failoverRequests: Array<Record<string, unknown>> = [];
    const staleStub = await startBlueBubblesApiStub(async (req, _body, res) => {
      if ((req.url || '').startsWith('/api/v1/webhook')) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ data: [] }));
        return;
      }
      if ((req.url || '').startsWith('/api/v1/server/info')) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ data: { private_api: true } }));
        return;
      }
      if (
        (req.method || 'GET').toUpperCase() === 'GET' &&
        (req.url || '').startsWith('/api/v1/message')
      ) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ data: [] }));
        return;
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: { guid: 'stale-should-not-send' } }));
    });
    const healthyStub = await startBlueBubblesApiStub(async (req, body, res) => {
      if ((req.url || '').startsWith('/api/v1/webhook')) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ data: [] }));
        return;
      }
      if ((req.url || '').startsWith('/api/v1/server/info')) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ data: { private_api: false } }));
        return;
      }
      if (
        (req.method || 'GET').toUpperCase() === 'GET' &&
        (req.url || '').startsWith('/api/v1/message')
      ) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ data: [] }));
        return;
      }
      failoverRequests.push(JSON.parse(body) as Record<string, unknown>);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: { guid: 'healthy-after-failover' } }));
    });

    const channel = new BlueBubblesChannel(
      buildConfig({
        baseUrl: staleStub.baseUrl,
        baseUrlCandidates: [staleStub.baseUrl, healthyStub.baseUrl],
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

    let staleClosed = false;
    try {
      await channel.connect();
      await staleStub.close();
      staleClosed = true;

      const result = await channel.sendMessage('bb:chat-1', 'Hello after failover.');
      const monitorState = readBlueBubblesMonitorState();

      expect(result.platformMessageId).toBe('bb:healthy-after-failover');
      expect(monitorState.activeBaseUrl).toBe(healthyStub.baseUrl);
      expect(failoverRequests).toHaveLength(1);
      expect(failoverRequests[0]).toMatchObject({
        chatGuid: 'chat-1',
        method: 'apple-script',
      });
    } finally {
      await channel.disconnect();
      if (!staleClosed) {
        await staleStub.close();
      }
      await healthyStub.close();
    }
  });

  it('sends one Telegram fallback notice after repeated transport failures and then enters cooldown', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-12T20:10:00.000Z'));

    const onCrossSurfaceFallback = vi.fn(async () => ({
      sent: true,
      detail: 'sent fallback notice to tg:main',
    }));
    const channel = new BlueBubblesChannel(
      buildConfig({
        baseUrl: 'http://127.0.0.1:9',
        baseUrlCandidates: ['http://127.0.0.1:9'],
        chatScope: 'all_synced',
        allowedChatGuids: [],
        allowedChatGuid: null,
      }),
      {
        onMessage: vi.fn(),
        onChatMetadata: vi.fn(),
        registeredGroups: () => ({}),
        onHealthUpdate: vi.fn(),
        onCrossSurfaceFallback,
      },
    );

    try {
      await channel.connect();

      let monitorState = readBlueBubblesMonitorState();
      expect(onCrossSurfaceFallback).not.toHaveBeenCalled();
      expect(monitorState.crossSurfaceFallbackState).toBe('armed');

      vi.setSystemTime(new Date('2026-04-12T20:11:20.000Z'));
      await (channel as any).runShadowMonitorOnce();

      monitorState = readBlueBubblesMonitorState();
      expect(onCrossSurfaceFallback).toHaveBeenCalledTimes(1);
      expect(onCrossSurfaceFallback).toHaveBeenCalledWith({
        sourceChannel: 'bluebubbles',
        detail: expect.stringContaining('could not reach the BlueBubbles server'),
        chatJid: null,
      });
      expect(monitorState.crossSurfaceFallbackState).toBe('sent');

      vi.setSystemTime(new Date('2026-04-12T20:12:40.000Z'));
      await (channel as any).runShadowMonitorOnce();
      monitorState = readBlueBubblesMonitorState();
      expect(onCrossSurfaceFallback).toHaveBeenCalledTimes(1);
      expect(monitorState.crossSurfaceFallbackState).toBe('cooldown');
    } finally {
      await channel.disconnect();
    }
  });

  it('records mention-gated Messages turns as ignored by gate or scope without triggering fallback', async () => {
    const onCrossSurfaceFallback = vi.fn(async () => ({
      sent: true,
      detail: 'sent fallback notice to tg:main',
    }));
    const apiStub = await startBlueBubblesApiStub(async (req, _body, res) => {
      if ((req.url || '').startsWith('/api/v1/webhook')) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ data: [] }));
        return;
      }
      if ((req.url || '').startsWith('/api/v1/server/info')) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ data: { private_api: true } }));
        return;
      }
      if (
        (req.method || 'GET').toUpperCase() === 'GET' &&
        (req.url || '').startsWith('/api/v1/message')
      ) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ data: [] }));
        return;
      }
      res.statusCode = 404;
      res.end('not found');
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
        onCrossSurfaceFallback,
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
            chatGuid: 'iMessage;-;+14695550123',
            chat: {
              guid: 'iMessage;-;+14695550123',
              displayName: 'Jeff',
              participants: [{ address: '+14695550123' }],
              isGroup: false,
            },
            message: {
              guid: 'ignored-self-msg-1',
              body: 'just checking in',
              senderName: 'Jeff',
              isFromMe: true,
              handle: { address: '+14695550123', displayName: 'Jeff' },
              dateCreated: '2026-04-12T20:08:00.000Z',
            },
          },
        }),
      });

      const monitorState = readBlueBubblesMonitorState();
      expect(response.status).toBe(202);
      expect(monitorState.detectionState).toBe('ignored_by_gate_or_scope');
      expect(monitorState.lastIgnoredChatJid).toBe('bb:iMessage;-;+14695550123');
      expect(monitorState.lastIgnoredReason).toBe('mention_required');
      expect(monitorState.crossSurfaceFallbackState).toBe('idle');
      expect(onCrossSurfaceFallback).not.toHaveBeenCalled();
    } finally {
      await channel.disconnect();
      await apiStub.close();
    }
  });

  it('ignores self-authored non-mention recent traffic when classifying bridge health', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-12T20:10:00.000Z'));

    const apiStub = await startBlueBubblesApiStub(async (req, _body, res) => {
      if ((req.url || '').startsWith('/api/v1/webhook')) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ data: [] }));
        return;
      }
      if ((req.url || '').startsWith('/api/v1/server/info')) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ data: { private_api: true } }));
        return;
      }
      if (
        (req.method || 'GET').toUpperCase() === 'GET' &&
        (req.url || '').startsWith('/api/v1/message')
      ) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            data: [
              {
                guid: 'shadow-self-msg-1',
                body: 'sounds good',
                isFromMe: true,
                dateCreated: '2026-04-12T20:00:00.000Z',
                chats: [
                  {
                    guid: 'iMessage;-;+14695550123',
                    displayName: 'Jeff',
                    participants: [{ address: '+14695550123' }],
                    isGroup: false,
                  },
                ],
                handle: { address: '+14695550123', displayName: 'Jeff' },
              },
            ],
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end('not found');
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

      const monitorState = readBlueBubblesMonitorState();
      expect(monitorState.detectionState).toBe('healthy');
      expect(monitorState.lastIgnoredReason).toBeNull();
      expect(monitorState.crossSurfaceFallbackState).toBe('idle');
    } finally {
      await channel.disconnect();
      await apiStub.close();
    }
  });

  it('accepts self-authored non-mention traffic in the BlueBubbles companion self-thread', async () => {
    const apiStub = await startBlueBubblesApiStub(async (req, _body, res) => {
      if ((req.url || '').startsWith('/api/v1/webhook')) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ data: [] }));
        return;
      }
      if ((req.url || '').startsWith('/api/v1/server/info')) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ data: { private_api: true } }));
        return;
      }
      res.statusCode = 404;
      res.end('not found');
    });
    const onMessage = vi.fn(async (_chatJid, message) => {
      storeMessage(message);
    });
    const onChatMetadata = vi.fn(
      async (chatJid: string, timestamp: string, name?: string, channel?: string, isGroup?: boolean) => {
        storeChatMetadata(chatJid, timestamp, name, channel, isGroup);
      },
    );
    const channel = new BlueBubblesChannel(
      buildConfig({
        baseUrl: apiStub.baseUrl,
        chatScope: 'all_synced',
        allowedChatGuids: [],
        allowedChatGuid: null,
      }),
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
            chatGuid: 'iMessage;-;+14695405551',
            chat: {
              guid: 'iMessage;-;+14695405551',
              displayName: 'Jeff',
              participants: [{ address: '+14695405551' }],
              isGroup: false,
            },
            message: {
              guid: 'self-thread-msg-1',
              body: 'what do i still need to buy',
              senderName: 'Jeff',
              isFromMe: true,
              handle: { address: '+14695405551', displayName: 'Jeff' },
              dateCreated: '2026-04-12T20:08:00.000Z',
            },
          },
        }),
      });

      expect(response.status).toBe(200);
      expect(onMessage).toHaveBeenCalledTimes(1);
      expect(onMessage).toHaveBeenCalledWith(
        'bb:iMessage;-;+14695405551',
        expect.objectContaining({
          content: 'what do i still need to buy',
          is_from_me: true,
        }),
      );
    } finally {
      await channel.disconnect();
      await apiStub.close();
    }
  });

  it('still treats a self-authored @Andrea prompt as eligible missed-inbound evidence when the webhook never sees it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-12T20:10:00.000Z'));

    const apiStub = await startBlueBubblesApiStub(async (req, _body, res) => {
      if ((req.url || '').startsWith('/api/v1/webhook')) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ data: [] }));
        return;
      }
      if ((req.url || '').startsWith('/api/v1/server/info')) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ data: { private_api: true } }));
        return;
      }
      if (
        (req.method || 'GET').toUpperCase() === 'GET' &&
        (req.url || '').startsWith('/api/v1/message')
      ) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            data: [
              {
                guid: 'shadow-self-mention-1',
                body: '@Andrea what am I forgetting?',
                isFromMe: true,
                dateCreated: '2026-04-12T20:00:00.000Z',
                chats: [
                  {
                    guid: 'iMessage;-;+14695550123',
                    displayName: 'Jeff',
                    participants: [{ address: '+14695550123' }],
                    isGroup: false,
                  },
                ],
                handle: { address: '+14695550123', displayName: 'Jeff' },
              },
            ],
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end('not found');
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

      const monitorState = readBlueBubblesMonitorState();
      expect(monitorState.detectionState).toBe('suspected_missed_inbound');
      expect(monitorState.detectionDetail).toContain(
        'Andrea has not observed that inbound on the webhook side yet',
      );
    } finally {
      await channel.disconnect();
      await apiStub.close();
    }
  });

  it('falls back to per-chat history when the global recent-activity endpoint is unavailable', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-12T20:10:00.000Z'));

    const apiStub = await startBlueBubblesApiStub(async (req, _body, res) => {
      if ((req.url || '').startsWith('/api/v1/webhook')) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ data: [] }));
        return;
      }
      if ((req.url || '').startsWith('/api/v1/server/info')) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ data: { private_api: false } }));
        return;
      }
      if (
        (req.method || 'GET').toUpperCase() === 'GET' &&
        (req.url || '').startsWith('/api/v1/message?')
      ) {
        res.statusCode = 404;
        res.end('Not Found');
        return;
      }
      if ((req.url || '').includes('/api/v1/chat/iMessage%3B-%3B%2B14695405551/message')) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            data: [
              {
                guid: 'shadow-self-thread-1',
                text: '@Andrea what should I send back?',
                senderName: 'Jeff',
                isFromMe: true,
                dateCreated: '2026-04-12T20:09:30.000Z',
                chats: [
                  {
                    guid: 'iMessage;-;+14695405551',
                    displayName: 'Jeff',
                    participants: [{ address: '+14695405551' }],
                    isGroup: false,
                  },
                ],
                handle: { address: '+14695405551', displayName: 'Jeff' },
              },
            ],
          }),
        );
        return;
      }
      if ((req.url || '').includes('/api/v1/chat/iMessage%3B-%3B%2B12147254219/message')) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            data: [
              {
                guid: 'shadow-recent-1',
                text: 'Noice',
                senderName: 'Friend',
                isFromMe: false,
                dateCreated: '2026-04-12T20:09:45.000Z',
                chats: [
                  {
                    guid: 'iMessage;-;+12147254219',
                    displayName: 'Friend',
                    participants: [{ address: '+12147254219' }],
                    isGroup: false,
                  },
                ],
                handle: { address: '+12147254219', displayName: 'Friend' },
              },
            ],
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end('not found');
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
      storeChatMetadata(
        'bb:iMessage;-;+12147254219',
        '2026-04-12T20:09:40.000Z',
        'Friend',
        'bluebubbles',
        false,
      );

      await channel.connect();

      const monitorState = readBlueBubblesMonitorState();
      expect(monitorState.shadowPollLastError).toBeNull();
      expect(monitorState.shadowPollMostRecentChat).toBe('bb:iMessage;-;+12147254219');
      expect(monitorState.mostRecentServerSeenChatJid).toBe(
        'bb:iMessage;-;+12147254219',
      );
      expect(monitorState.detectionState).toBe('healthy');
    } finally {
      await channel.disconnect();
      await apiStub.close();
    }
  });

  it('rehydrates persisted same-thread outbound diagnostics into health updates after restart', async () => {
    const apiStub = await startBlueBubblesApiStub(async (req, _body, res) => {
      if ((req.url || '').startsWith('/api/v1/webhook')) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ data: [] }));
        return;
      }
      if ((req.url || '').startsWith('/api/v1/server/info')) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ data: { private_api: false } }));
        return;
      }
      if (
        (req.method || 'GET').toUpperCase() === 'GET' &&
        (req.url || '').startsWith('/api/v1/message?')
      ) {
        res.statusCode = 404;
        res.end('Not Found');
        return;
      }
      if ((req.url || '').includes('/api/v1/chat/iMessage%3B-%3B%2B14695405551/message')) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ data: [] }));
        return;
      }
      res.statusCode = 404;
      res.end('not found');
    });

    writeBlueBubblesMonitorState({
      ...createDefaultBlueBubblesMonitorState('2026-04-12T20:05:00.000Z'),
      updatedAt: '2026-04-12T20:05:00.000Z',
      lastInboundObservedAt: '2026-04-12T20:04:00.000Z',
      lastInboundChatJid: 'bb:iMessage;-;+14695405551',
      lastInboundWasSelfAuthored: true,
      lastOutboundObservedAt: '2026-04-12T20:05:00.000Z',
      lastOutboundObservedChatJid: 'bb:iMessage;-;+14695405551',
      lastOutboundTargetKind: 'chat_guid',
      lastOutboundTargetValue: 'iMessage;-;+14695405551',
      lastMetadataHydrationSource: 'history',
      lastAttemptedTargetSequence: ['chat_guid', 'service_specific_direct'],
    });

    const healthUpdates: string[] = [];
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
        onHealthUpdate: (snapshot) => {
          healthUpdates.push(snapshot.detail || '');
        },
      },
    );

    try {
      await channel.connect();

      const latestDetail = healthUpdates[healthUpdates.length - 1] || '';
      expect(latestDetail).toContain('reply gate direct_1to1');
      expect(latestDetail).toContain(
        'last outbound 2026-04-12T20:05:00.000Z (bb:iMessage;-;+14695405551)',
      );
      expect(latestDetail).toContain('last outbound target kind chat_guid');
      expect(latestDetail).toContain(
        'last outbound target value iMessage;-;+14695405551',
      );
      expect(latestDetail).toContain('last metadata hydration history');
      expect(latestDetail).toContain(
        'attempted target sequence chat_guid -> service_specific_direct',
      );
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
