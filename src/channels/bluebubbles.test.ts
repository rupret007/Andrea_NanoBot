import http from 'http';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _initTestDatabase, storeChatMetadata, storeMessage } from '../db.js';
import type { BlueBubblesConfig } from '../types.js';
import {
  BlueBubblesChannel,
  buildBlueBubblesHealthSnapshot,
  normalizeBlueBubblesIncomingMessage,
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
      allowedChatGuid: 'chat-1',
      webhookPath: '/bluebubbles/incoming',
      webhookSecret: 'hook-secret',
      sendEnabled: false,
    });
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
      const result = await channel.sendMessage('bb:chat-1', 'Andrea reply');

      expect(result.platformMessageId).toBe('bb:server-msg-7');
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toContain('/api/v1/message/text');
      expect(requests[0]?.url).toContain('guid=secret');
      expect(requests[0]?.url).toContain('password=secret');
      expect(requests[0]?.url).toContain('token=secret');
      expect(requests[0]?.body).toMatchObject({
        chatGuid: 'chat-1',
        text: 'Andrea reply',
      });
    } finally {
      await channel.disconnect();
      await apiStub.close();
    }
  });

  it('falls back to a plain same-chat send when reply threading is rejected', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const apiStub = await startBlueBubblesApiStub(async (_req, body, res) => {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      requests.push(parsed);
      if (parsed.replyToGuid) {
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
      expect(requests[0]?.replyToGuid).toBe('msg-2');
      expect(requests[1]?.replyToGuid).toBeUndefined();
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
});
