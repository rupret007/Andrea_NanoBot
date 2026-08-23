import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import './index.js';

import {
  clearBlueBubblesMonitorState,
  createDefaultBlueBubblesMonitorState,
  readBlueBubblesMonitorState,
  writeBlueBubblesMonitorState,
} from '../bluebubbles-monitor-state.js';
import {
  _closeDatabase,
  _initTestDatabase,
  getAllChats,
  getActionableMessagesSince,
  listMessageActionsForGroup,
  listRecentMessagesForChat,
  storeChatMetadata,
  storeMessage,
  storeMessageDirect,
  updateMessageAction,
} from '../db.js';
import { executeBlueBubblesOutboundTurn } from '../bluebubbles-outbound-turn.js';
import { applyMessageActionOperation } from '../message-actions.js';
import {
  captureMessagingOutboundAuthorizationFence,
  setMessagingOutboundPaused,
} from '../messaging-outbound-pause.js';
import { resolveBlueBubblesReceiptInboxBuildId } from '../bluebubbles-receipt-inbox-service.js';
import {
  buildBlueBubblesReceiptInboxConfigIdentity,
  BlueBubblesReceiptInboxStore,
} from '../bluebubbles-receipt-inbox-store.js';
import { runtimeCapabilityRegistry } from '../runtime-capability-registry.js';
import { registerProductionRuntimeCapabilitySurfaces } from '../runtime-capability-production-surfaces.js';
import type {
  BlueBubblesChannelControlSnapshot,
  BlueBubblesConfig,
  RegisteredGroup,
} from '../types.js';
import {
  BlueBubblesChannel,
  buildBlueBubblesHealthSnapshot,
  buildBlueBubblesWebhookUrl,
  inspectBlueBubblesReceiptInboxWebhookRegistration,
  inspectBlueBubblesWebhookRegistration,
  isBlueBubblesChatEligible,
  normalizeBlueBubblesIncomingMessage,
  primeBlueBubblesChatHistory,
  probeBlueBubblesReceiptInbox,
  redactBlueBubblesWebhookUrl,
  resolveBlueBubblesConfig,
  resolveBlueBubblesSendMethod,
} from './bluebubbles.js';

registerProductionRuntimeCapabilitySurfaces(runtimeCapabilityRegistry);

async function startBlueBubblesApiStub(
  handler: (
    req: http.IncomingMessage,
    body: string,
    res: http.ServerResponse,
  ) => void | Promise<void>,
  options: {
    onPing?: () => void | Promise<void>;
  } = {},
): Promise<{
  baseUrl: string;
  close(): Promise<void>;
}> {
  const server = http.createServer(async (req, res) => {
    if (
      (req.method || 'GET').toUpperCase() === 'GET' &&
      (req.url || '').startsWith('/api/v1/ping')
    ) {
      await options.onPing?.();
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          status: 200,
          message: 'Ping received!',
          data: 'pong',
        }),
      );
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
    close: () => {
      return new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        // Start shutdown before terminating sockets so a just-accepted request
        // cannot race in between these two operations and hold the test open.
        server.closeAllConnections();
      });
    },
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
    serverPublicUrl: null,
    localPort: null,
    imessageAccountLabel: null,
    computerId: null,
    chatScope: 'allowlist',
    allowedChatGuids: ['chat-1'],
    allowedChatGuid: 'chat-1',
    webhookPath: '/bluebubbles/webhook',
    webhookSecret: 'hook-secret',
    sendEnabled: true,
    receiptInboxEnabled: true,
    receiptInboxDatabasePath: ':memory:',
    receiptInboxBaseUrl: null,
    receiptInboxWebhookPath: '/bluebubbles/receipt-inbox',
    receiptInboxWebhookPublicBaseUrl: null,
    receiptInboxWebhookUrl: null,
    receiptInboxHealthPath: '/health',
    receiptInboxHealthUrl: null,
    receiptInboxSupervisionRequired: false,
    ...overrides,
  };
  if (!overrides.baseUrlCandidates) {
    config.baseUrlCandidates = config.baseUrl ? [config.baseUrl] : [];
  }
  return config;
}

function buildBlueBubblesAuthorizationOptions(
  authorizationAt = new Date().toISOString(),
): Pick<
  import('../types.js').SendMessageOptions,
  'blueBubblesAuthorizationAt' | 'blueBubblesPauseGeneration'
> {
  const fence = captureMessagingOutboundAuthorizationFence(authorizationAt);
  return {
    blueBubblesAuthorizationAt: fence.authorizationAt,
    blueBubblesPauseGeneration: fence.pauseGeneration,
  };
}

describe('resolveBlueBubblesSendMethod', () => {
  it('never selects Private API, including unknown or advertised-available probes', () => {
    expect(resolveBlueBubblesSendMethod()).toBe('apple-script');
    expect(resolveBlueBubblesSendMethod(null)).toBe('apple-script');
    expect(resolveBlueBubblesSendMethod('private-api')).toBe('apple-script');
    expect(resolveBlueBubblesSendMethod('PRIVATE-API')).toBe('apple-script');
    expect(resolveBlueBubblesSendMethod('private_api')).toBe('apple-script');
    expect(resolveBlueBubblesSendMethod('  private-api  ')).toBe(
      'apple-script',
    );
    expect(resolveBlueBubblesSendMethod('apple-script')).toBe('apple-script');
  });

  it('keeps every outbound send body on the AppleScript resolver', () => {
    const source = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'bluebubbles.ts'),
      'utf8',
    );
    expect(source).toContain('method: resolveBlueBubblesSendMethod');
    expect(source).toContain("form.set('method', resolveBlueBubblesSendMethod");
    expect(source).not.toMatch(/method:\s*['"]private-api['"]/);
    expect(source).not.toMatch(
      /form\.set\(\s*['"]method['"]\s*,\s*['"]private-api['"]/,
    );
  });
});

describe('BlueBubbles channel', () => {
  let tempProjectRoot: string;

  beforeEach(() => {
    tempProjectRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'andrea-bluebubbles-monitor-'),
    );
    vi.spyOn(process, 'cwd').mockReturnValue(tempProjectRoot);
    // Most transport tests use bb:iMessage;-;fixture-chat-1 as the owner companion fixture. Make
    // that authority explicit so contact-destination tests cannot inherit it
    // merely from chat scope or an allowlist.
    vi.stubEnv(
      'BLUEBUBBLES_CANONICAL_SELF_THREAD_JID',
      'bb:iMessage;-;fixture-chat-1',
    );
    _initTestDatabase();
    clearBlueBubblesMonitorState();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.useRealTimers();
    clearBlueBubblesMonitorState();
    fs.rmSync(tempProjectRoot, { recursive: true, force: true });
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
      BLUEBUBBLES_RECEIPT_INBOX_ENABLED: 'true',
      BLUEBUBBLES_RECEIPT_INBOX_DB_PATH: '~/.andrea-test/receipt-inbox.sqlite3',
      BLUEBUBBLES_RECEIPT_INBOX_PATH: '/bluebubbles/receipt-inbox',
      BLUEBUBBLES_RECEIPT_INBOX_BASE_URL: 'http://127.0.0.1:4316',
      BLUEBUBBLES_RECEIPT_INBOX_WEBHOOK_PUBLIC_BASE_URL:
        'http://192.168.5.136:4316',
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
      receiptInboxEnabled: true,
      receiptInboxDatabasePath: path.join(
        os.homedir(),
        '.andrea-test',
        'receipt-inbox.sqlite3',
      ),
      receiptInboxWebhookPath: '/bluebubbles/receipt-inbox',
      receiptInboxWebhookUrl:
        'http://192.168.5.136:4316/bluebubbles/receipt-inbox?secret=hook-secret',
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
      expect(inspection.detail).toContain(
        'registered on the BlueBubbles server',
      );
      expect(inspection.webhookId).toBe(7);
    } finally {
      await apiStub.close();
    }
  });

  it('requires a distinct exact receipt webhook registered for new-message', async () => {
    let receiptEvents = ['new-message'];
    const receiptWebhookUrl =
      'http://127.0.0.1:4306/bluebubbles/receipt-inbox?secret=hook-secret';
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
              { id: 8, url: receiptWebhookUrl, events: receiptEvents },
            ],
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end('not found');
    });
    const config = buildConfig({
      baseUrl: apiStub.baseUrl,
      receiptInboxEnabled: true,
      receiptInboxWebhookUrl: receiptWebhookUrl,
    });

    try {
      const registered =
        await inspectBlueBubblesReceiptInboxWebhookRegistration(config);
      expect(registered).toMatchObject({
        state: 'registered',
        webhookId: 8,
      });

      receiptEvents = ['new-message', 'updated-message'];
      const wrongEvents =
        await inspectBlueBubblesReceiptInboxWebhookRegistration(config);
      expect(wrongEvents).toMatchObject({ state: 'missing', webhookId: 8 });
      expect(wrongEvents.detail).toContain('exactly the new-message event');
    } finally {
      await apiStub.close();
    }
  });

  it('rejects a receipt webhook that resolves to the main webhook endpoint', async () => {
    let inspectionRequests = 0;
    const apiStub = await startBlueBubblesApiStub(async (req, _body, res) => {
      if ((req.url || '').startsWith('/api/v1/webhook')) {
        inspectionRequests += 1;
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ data: [] }));
        return;
      }
      res.statusCode = 404;
      res.end('not found');
    });
    const publicBaseUrl = 'http://127.0.0.1:4305';
    const config = buildConfig({
      baseUrl: apiStub.baseUrl,
      webhookPublicBaseUrl: publicBaseUrl,
      receiptInboxEnabled: true,
      receiptInboxWebhookUrl: `${publicBaseUrl}/bluebubbles/webhook?secret=different-query-value`,
    });

    try {
      const inspection =
        await inspectBlueBubblesReceiptInboxWebhookRegistration(config);

      expect(inspection).toMatchObject({ state: 'missing' });
      expect(inspection.detail).toContain('distinct origin or path');
      expect(inspectionRequests).toBe(0);
    } finally {
      await apiStub.close();
    }
  });

  it('binds receipt readiness to the exact sidecar build, database, and webhook path', async () => {
    const databasePath = path.join(tempProjectRoot, 'receipt-inbox.sqlite3');
    const receiptWebhookUrl =
      'http://127.0.0.1:4306/bluebubbles/receipt-inbox?secret=hook-secret';
    let providerInspectionRequests = 0;
    const providerStub = await startBlueBubblesApiStub(
      async (req, _body, res) => {
        if ((req.url || '').startsWith('/api/v1/webhook')) {
          providerInspectionRequests += 1;
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({
              data: [
                {
                  id: 8,
                  url: receiptWebhookUrl,
                  events: ['new-message'],
                },
              ],
            }),
          );
          return;
        }
        res.statusCode = 404;
        res.end('not found');
      },
    );
    let healthConfigIdentity = buildBlueBubblesReceiptInboxConfigIdentity({
      databasePath,
      webhookPath: '/bluebubbles/receipt-inbox',
    });
    let healthBuildId = resolveBlueBubblesReceiptInboxBuildId();
    const healthStub = await startBlueBubblesApiStub(
      async (req, _body, res) => {
        if ((req.url || '').startsWith('/health')) {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({
              status: 'ok',
              schemaVersion: 2,
              serviceKind: 'bluebubbles-receipt-inbox',
              protocolVersion: 2,
              pid: 4242,
              startedAt: '2026-07-16T12:00:00.000Z',
              buildId: healthBuildId,
              webhookPath: '/bluebubbles/receipt-inbox',
              configIdentity: healthConfigIdentity,
            }),
          );
          return;
        }
        res.statusCode = 404;
        res.end('not found');
      },
    );
    const config = buildConfig({
      baseUrl: providerStub.baseUrl,
      receiptInboxEnabled: true,
      receiptInboxDatabasePath: databasePath,
      receiptInboxHealthUrl: `${healthStub.baseUrl}/health`,
      receiptInboxWebhookPath: '/bluebubbles/receipt-inbox',
      receiptInboxWebhookUrl: receiptWebhookUrl,
      receiptInboxSupervisionRequired: true,
    });

    try {
      await expect(probeBlueBubblesReceiptInbox(config)).resolves.toMatchObject(
        { state: 'reachable' },
      );
      expect(providerInspectionRequests).toBe(1);

      healthConfigIdentity = buildBlueBubblesReceiptInboxConfigIdentity({
        databasePath: `${databasePath}.stale-sidecar`,
        webhookPath: '/bluebubbles/receipt-inbox',
      });
      await expect(probeBlueBubblesReceiptInbox(config)).resolves.toMatchObject(
        { state: 'unreachable' },
      );
      expect(providerInspectionRequests).toBe(1);

      healthConfigIdentity = buildBlueBubblesReceiptInboxConfigIdentity({
        databasePath,
        webhookPath: '/bluebubbles/receipt-inbox',
      });
      healthBuildId = 'stale-sidecar-build';
      await expect(probeBlueBubblesReceiptInbox(config)).resolves.toMatchObject(
        { state: 'unreachable' },
      );
      expect(providerInspectionRequests).toBe(1);
    } finally {
      await healthStub.close();
      await providerStub.close();
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

  it('normalizes the BlueBubbles tempGuid as provider idempotency evidence', () => {
    const normalized = normalizeBlueBubblesIncomingMessage({
      type: 'new-message',
      data: {
        guid: 'provider-message-1',
        tempGuid: 'message-action:stable-provider-key-1',
        text: 'Hi from Andrea — 👋🏽',
        dateCreated: '2026-04-05T12:00:00.000Z',
        isFromMe: true,
        handle: { address: '+15551234567' },
        chats: [
          {
            guid: 'chat-1',
            participants: [{ address: '+15551234567' }],
          },
        ],
      },
    });

    expect(normalized?.message).toMatchObject({
      id: 'bb:provider-message-1',
      provider_idempotency_key: 'message-action:stable-provider-key-1',
      is_from_me: true,
    });
  });

  it('treats a BlueBubbles `;+;` GUID as a group even when stale metadata says direct', () => {
    const chatJid = 'bb:iMessage;+;chat123456';
    const normalized = normalizeBlueBubblesIncomingMessage({
      type: 'new-message',
      data: {
        guid: 'group-message-1',
        chats: [
          {
            guid: 'iMessage;+;chat123456',
            displayName: 'Family chat',
            isGroup: false,
            participants: [{ address: '+15550001111' }],
          },
        ],
        handle: { address: '+15550001111' },
        text: 'Can everyone make it tonight?',
        dateCreated: '2026-04-05T12:00:00.000Z',
      },
    });
    expect(normalized?.chat.isGroup).toBe(true);

    storeChatMetadata(
      chatJid,
      '2026-04-05T12:00:00.000Z',
      'Family chat',
      'bluebubbles',
      false,
    );
    expect(getAllChats().find((chat) => chat.jid === chatJid)?.is_group).toBe(
      1,
    );
  });

  it('normalizes native tapbacks as structured control signals without copying the target text', () => {
    const normalized = normalizeBlueBubblesIncomingMessage({
      type: 'new-message',
      data: {
        guid: 'reaction-1',
        chatGuid: 'chat-1',
        chat: {
          guid: 'chat-1',
          participants: [{ address: '+15551234567' }],
        },
        message: {
          guid: 'reaction-1',
          associatedMessageGuid: 'bp:0/assistant-message-1',
          associatedMessageType: 'like',
          handle: { address: '+15551234567' },
          dateCreated: '2026-04-05T12:00:00.000Z',
        },
      },
    });

    expect(normalized?.message.content).toBe('[BlueBubbles reaction: like]');
    expect(normalized?.message.reaction).toEqual({
      kind: 'like',
      removed: false,
      targetMessageId: 'bb:assistant-message-1',
    });
    expect(normalized?.message.content).not.toContain('assistant-message-1');
  });

  it('normalizes numeric tapback removals but leaves them ineligible for learning', () => {
    const normalized = normalizeBlueBubblesIncomingMessage({
      type: 'new-message',
      data: {
        guid: 'reaction-2',
        associatedMessageGuid: 'p:0/assistant-message-2',
        associatedMessageType: 3002,
        handle: { address: '+15551234567' },
        chats: [
          {
            guid: 'chat-1',
            participants: [{ address: '+15551234567' }],
          },
        ],
        dateCreated: '2026-04-05T12:00:00.000Z',
      },
    });

    expect(normalized?.message.reaction).toEqual({
      kind: 'dislike',
      removed: true,
      targetMessageId: 'bb:assistant-message-2',
    });
  });

  it('normalizes image-only BlueBubbles messages with attachment metadata', () => {
    const normalized = normalizeBlueBubblesIncomingMessage({
      type: 'new-message',
      data: {
        guid: 'msg-image-1',
        chatGuid: 'chat-1',
        chat: {
          guid: 'chat-1',
          displayName: 'Candace',
          participants: [{ address: '+15551234567' }],
        },
        message: {
          guid: 'msg-image-1',
          senderName: 'Candace',
          handle: {
            address: '+15551234567',
            displayName: 'Candace',
          },
          attachments: [
            {
              guid: 'attach-1',
              transferName: 'photo.jpg',
              mimeType: 'image/jpeg',
              totalBytes: 1234,
            },
          ],
          dateCreated: '2026-04-05T12:00:00.000Z',
        },
      },
    });

    expect(normalized?.message.content).toBe('[image]');
    expect(normalized?.message.attachments?.[0]).toMatchObject({
      sourceChannel: 'bluebubbles',
      kind: 'image',
      filename: 'photo.jpg',
      sourceId: 'attach-1',
      fetchStatus: 'metadata_only',
    });
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
          isGroup: true,
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

  it('upgrades an exact history-hydrated row when its live webhook arrives', async () => {
    const apiStub = await startBlueBubblesApiStub(async (_req, _body, res) => {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: [] }));
    });
    const chatJid = 'bb:chat-1';
    const messageId = 'bb:history-before-live-1';
    storeChatMetadata(
      chatJid,
      '2026-07-16T13:00:00.000Z',
      'Candace',
      'bluebubbles',
      false,
    );
    storeMessageDirect({
      id: messageId,
      chat_jid: chatJid,
      sender: 'bb:+15551234567',
      sender_name: 'Candace',
      content: '@Andrea this live delivery arrived after history hydration',
      timestamp: '2026-07-16T13:00:00.000Z',
      is_from_me: false,
      message_ingress_origin: 'history_hydration',
    });
    const onMessage = vi.fn(async (_chatJid, message) => {
      storeMessage(message);
    });
    const channel = new BlueBubblesChannel(
      buildConfig({ baseUrl: apiStub.baseUrl }),
      {
        onMessage,
        onChatMetadata: vi.fn(
          async (
            incomingChatJid: string,
            timestamp: string,
            name?: string,
            channelName?: string,
            isGroup?: boolean,
          ) => {
            storeChatMetadata(
              incomingChatJid,
              timestamp,
              name,
              channelName,
              isGroup,
            );
          },
        ),
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
            chatGuid: 'chat-1',
            chat: {
              guid: 'chat-1',
              displayName: 'Candace',
              participants: [{ address: '+15551234567' }],
            },
            message: {
              guid: 'history-before-live-1',
              body: '@Andrea this live delivery arrived after history hydration',
              senderName: 'Candace',
              handle: {
                address: '+15551234567',
                displayName: 'Candace',
              },
              dateCreated: '2026-07-16T13:00:00.000Z',
            },
          },
        }),
      });

      expect(response.status).toBe(200);
      expect(onMessage).toHaveBeenCalledTimes(1);
      expect(
        getActionableMessagesSince(chatJid, '', 'Andrea').map(
          (message) => message.id,
        ),
      ).toEqual([messageId]);
    } finally {
      await channel.disconnect();
      await apiStub.close();
    }
  });

  it('does not fingerprint-suppress a retry until a live callback is durably accepted', async () => {
    const apiStub = await startBlueBubblesApiStub(async (_req, _body, res) => {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: [] }));
    });
    let attempt = 0;
    const onMessage = vi.fn(async (_chatJid, message) => {
      attempt += 1;
      if (attempt === 1) {
        throw new Error('simulated main-store acceptance failure');
      }
      storeMessage(message);
    });
    const channel = new BlueBubblesChannel(
      buildConfig({ baseUrl: apiStub.baseUrl }),
      {
        onMessage,
        onChatMetadata: vi.fn(
          async (
            chatJid: string,
            timestamp: string,
            name?: string,
            channelName?: string,
            isGroup?: boolean,
          ) => {
            storeChatMetadata(chatJid, timestamp, name, channelName, isGroup);
          },
        ),
        registeredGroups: () => ({}),
        onHealthUpdate: vi.fn(),
      },
    );
    const payload = (guid: string) => ({
      type: 'new-message',
      data: {
        chatGuid: 'chat-1',
        chat: {
          guid: 'chat-1',
          displayName: 'Candace',
          participants: [{ address: '+15551234567' }],
        },
        message: {
          guid,
          body: '@Andrea retry this exact physical delivery',
          senderName: 'Candace',
          handle: {
            address: '+15551234567',
            displayName: 'Candace',
          },
          dateCreated: '2026-07-16T13:05:00.000Z',
        },
      },
    });

    try {
      await channel.connect();
      const first = await fetch(channel.getWebhookUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload('failed-fingerprint-guid-a')),
      });
      const retry = await fetch(channel.getWebhookUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload('failed-fingerprint-guid-b')),
      });
      const duplicateAfterAcceptance = await fetch(channel.getWebhookUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload('failed-fingerprint-guid-c')),
      });

      expect(first.status).toBe(500);
      expect(retry.status).toBe(200);
      expect(duplicateAfterAcceptance.status).toBe(202);
      expect(await duplicateAfterAcceptance.text()).toBe(
        'Ignored duplicate delivery',
      );
      expect(onMessage).toHaveBeenCalledTimes(2);
      expect(
        getActionableMessagesSince('bb:chat-1', '', 'Andrea').map(
          (message) => message.id,
        ),
      ).toEqual(['bb:failed-fingerprint-guid-b']);
    } finally {
      await channel.disconnect();
      await apiStub.close();
    }
  });

  it('keeps receiving signed Messages webhooks when outbound sending is disabled', async () => {
    const apiStub = await startBlueBubblesApiStub(async (_req, _body, res) => {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: { guid: 'server-msg-read-only' } }));
    });
    const onMessage = vi.fn();
    const channel = new BlueBubblesChannel(
      buildConfig({ baseUrl: apiStub.baseUrl, sendEnabled: false }),
      {
        onMessage,
        onChatMetadata: vi.fn(),
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
            chatGuid: 'chat-1',
            chat: {
              guid: 'chat-1',
              displayName: 'Candace',
              participants: [{ address: '+15551234567' }],
            },
            message: {
              guid: 'msg-read-only-inbound',
              body: 'Can you pick this up?',
              senderName: 'Candace',
              handle: {
                address: '+15551234567',
                displayName: 'Candace',
              },
              dateCreated: '2026-07-16T16:00:00.000Z',
            },
          },
        }),
      });

      expect(response.status).toBe(200);
      expect(onMessage).toHaveBeenCalledWith(
        'bb:chat-1',
        expect.objectContaining({
          id: 'bb:msg-read-only-inbound',
          content: 'Can you pick this up?',
        }),
      );
      await expect(
        channel.sendMessage('bb:iMessage;-;+15551234567', 'No outbound'),
      ).rejects.toMatchObject({
        code: 'CHANNEL_DELIVERY_REJECTED_BEFORE_DISPATCH',
      });
    } finally {
      await channel.disconnect();
      await apiStub.close();
    }
  });

  it('blocks text and artifact dispatch at the owner pause before transport work', async () => {
    setMessagingOutboundPaused({
      paused: true,
      changedByChatJid: 'tg:owner',
      reason: 'owner_natural_language_pause',
    });
    const channel = new BlueBubblesChannel(buildConfig(), {
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
      onHealthUpdate: vi.fn(),
    });

    expect(channel.getControlSnapshot().sendEnabled).toBe(false);
    await expect(
      channel.sendMessage('bb:iMessage;-;fixture-chat-1', 'must not dispatch'),
    ).rejects.toThrow('paused by the owner');
    await expect(
      channel.sendArtifact(
        'bb:iMessage;-;fixture-chat-1',
        {
          kind: 'file',
          filename: 'blocked.txt',
          mimeType: 'text/plain',
          bytesBase64: Buffer.from('blocked').toString('base64'),
        },
        {},
      ),
    ).rejects.toThrow('paused by the owner');
  });

  it('fails closed before provider dispatch when durable pause state is unavailable', async () => {
    const providerPosts: string[] = [];
    const apiStub = await startBlueBubblesApiStub(async (req, _body, res) => {
      if ((req.method || 'GET').toUpperCase() === 'POST') {
        providerPosts.push(req.url || '');
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      if ((req.url || '').startsWith('/api/v1/server/info')) {
        res.end(JSON.stringify({ data: { private_api: true } }));
        return;
      }
      res.end(JSON.stringify({ data: { guid: 'must-not-exist' } }));
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
      providerPosts.length = 0;
      const authorization = buildBlueBubblesAuthorizationOptions();
      _closeDatabase();

      await expect(
        channel.sendMessage(
          'bb:iMessage;-;+12025550123',
          'Durable state is required before this can send.',
          {
            ...authorization,
            suppressSenderLabel: true,
            idempotencyKey: 'message-action:db-unavailable',
          },
        ),
      ).rejects.toThrow('durable owner-pause state is unavailable');
      expect(providerPosts).toEqual([]);
    } finally {
      _initTestDatabase();
      await channel.disconnect();
      await apiStub.close();
    }
  });

  it('invalidates in-flight text, attachment, and first-contact sends across pause and resume', async () => {
    let pauseOnNextPing = false;
    const providerPostUrls: string[] = [];
    const apiStub = await startBlueBubblesApiStub(
      async (req, _body, res) => {
        if ((req.method || 'GET').toUpperCase() === 'POST') {
          providerPostUrls.push(req.url || '');
        }
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        if ((req.url || '').startsWith('/api/v1/server/info')) {
          res.end(JSON.stringify({ data: { private_api: true } }));
          return;
        }
        res.end(JSON.stringify({ data: [] }));
      },
      {
        onPing: () => {
          if (!pauseOnNextPing) return;
          pauseOnNextPing = false;
          setMessagingOutboundPaused({
            paused: true,
            changedByChatJid: 'tg:owner',
            reason: 'owner_pause_during_readiness',
          });
          setMessagingOutboundPaused({
            paused: false,
            changedByChatJid: 'tg:owner',
            reason: 'owner_resume_during_readiness',
          });
        },
      },
    );
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
      providerPostUrls.length = 0;

      pauseOnNextPing = true;
      await expect(
        channel.sendMessage(
          'bb:iMessage;-;fixture-chat-1',
          'must not cross the pause race',
        ),
      ).rejects.toThrow(/pause generation|latest owner stop boundary/);
      expect(providerPostUrls).toEqual([]);

      setMessagingOutboundPaused({
        paused: false,
        changedByChatJid: 'tg:owner',
        reason: 'test_reset_between_attempts',
      });
      pauseOnNextPing = true;
      await expect(
        channel.sendArtifact('bb:iMessage;-;fixture-chat-1', {
          kind: 'file',
          filename: 'blocked-after-readiness.txt',
          mimeType: 'text/plain',
          bytesBase64: Buffer.from('blocked').toString('base64'),
        }),
      ).rejects.toThrow(/pause generation|latest owner stop boundary/);
      expect(providerPostUrls).toEqual([]);

      setMessagingOutboundPaused({
        paused: false,
        changedByChatJid: 'tg:owner',
        reason: 'test_reset_before_first_contact_attempt',
      });
      pauseOnNextPing = true;
      await expect(
        channel.sendMessage(
          'bb:iMessage;-;+12025550199',
          'must not create a new chat across the pause race',
          {
            ...buildBlueBubblesAuthorizationOptions(),
            suppressSenderLabel: true,
            blueBubblesCreateChatAddress: '+12025550199',
            idempotencyKey: 'message-action:paused-first-contact',
          },
        ),
      ).rejects.toThrow(/pause generation|latest owner stop boundary/);
      expect(providerPostUrls).toEqual([]);
    } finally {
      await channel.disconnect();
      await apiStub.close();
    }
  });

  it('rejects a pre-stop queued authorization after resume and allows only a fresh post-resume action', async () => {
    const providerPosts: string[] = [];
    const apiStub = await startBlueBubblesApiStub(async (req, _body, res) => {
      if ((req.method || 'GET').toUpperCase() === 'POST') {
        providerPosts.push(req.url || '');
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      if ((req.url || '').startsWith('/api/v1/server/info')) {
        res.end(JSON.stringify({ data: { private_api: true } }));
        return;
      }
      res.end(JSON.stringify({ data: { guid: 'fresh-after-resume' } }));
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
      providerPosts.length = 0;
      setMessagingOutboundPaused({
        paused: true,
        changedByChatJid: 'tg:owner',
        reason: 'owner_stop_after_ingress',
        now: new Date('2026-07-16T20:01:00.000Z'),
      });
      setMessagingOutboundPaused({
        paused: false,
        changedByChatJid: 'tg:owner',
        reason: 'owner_resume_after_ingress',
        now: new Date('2026-07-16T20:02:00.000Z'),
      });

      await expect(
        channel.sendMessage(
          'bb:iMessage;-;+12025550123',
          'Stale queued instruction must not send.',
          {
            ...buildBlueBubblesAuthorizationOptions('2026-07-16T20:00:00.000Z'),
            suppressSenderLabel: true,
            idempotencyKey: 'message-action:stale-queued-after-resume',
          },
        ),
      ).rejects.toThrow('before the latest owner stop boundary');
      expect(providerPosts).toEqual([]);

      await expect(
        channel.sendMessage(
          'bb:iMessage;-;+12025550123',
          'Fresh owner action may send.',
          {
            ...buildBlueBubblesAuthorizationOptions('2026-07-16T20:02:00.001Z'),
            suppressSenderLabel: true,
            idempotencyKey: 'message-action:fresh-after-resume',
          },
        ),
      ).resolves.toMatchObject({
        platformMessageId: 'bb:fresh-after-resume',
      });
      expect(providerPosts).toHaveLength(1);
      expect(providerPosts[0]).toContain('/api/v1/message/text');
    } finally {
      await channel.disconnect();
      await apiStub.close();
    }
  });

  it('does not turn a Telegram-to-BlueBubbles send echoed in the self-thread into a new assistant prompt', async () => {
    const previousCanonical = process.env.BLUEBUBBLES_CANONICAL_SELF_THREAD_JID;
    process.env.BLUEBUBBLES_CANONICAL_SELF_THREAD_JID =
      'iMessage;-;+15551234567';
    const apiStub = await startBlueBubblesApiStub(async (req, _body, res) => {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      if ((req.url || '').startsWith('/api/v1/message/text')) {
        res.end(JSON.stringify({ data: { guid: 'provider-send-echo-1' } }));
        return;
      }
      res.end(JSON.stringify({ data: [] }));
    });
    const onMessage = vi.fn();
    const channel = new BlueBubblesChannel(
      buildConfig({
        baseUrl: apiStub.baseUrl,
        chatScope: 'all_synced',
        allowedChatGuids: [],
        allowedChatGuid: null,
      }),
      {
        onMessage,
        onChatMetadata: vi.fn(),
        registeredGroups: () => ({}),
        onHealthUpdate: vi.fn(),
      },
    );

    try {
      await channel.connect();
      await channel.sendMessage(
        'bb:iMessage;-;+15551234567',
        'Yes, please pick them up.',
        {
          suppressSenderLabel: true,
          idempotencyKey: 'message-action:candace-1',
        },
      );
      expect(
        getActionableMessagesSince('bb:iMessage;-;+15551234567', '', 'Andrea'),
      ).toEqual([]);
      const response = await fetch(channel.getWebhookUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'new-message',
          data: {
            chatGuid: 'iMessage;-;+15551234567',
            chat: {
              guid: 'iMessage;-;+15551234567',
              displayName: 'Jeff',
              participants: [{ address: '+15551234567' }],
            },
            message: {
              guid: 'provider-send-echo-1',
              body: 'Yes, please pick them up.',
              senderName: 'Jeff',
              isFromMe: true,
              handle: { address: '+15551234567', displayName: 'Jeff' },
              dateCreated: new Date().toISOString(),
            },
          },
        }),
      });

      expect(response.status).toBe(202);
      expect(await response.text()).toBe(
        'Ignored provider-correlated outbound echo',
      );
      expect(onMessage).not.toHaveBeenCalled();

      const distinctOwnerMessage = await fetch(channel.getWebhookUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'new-message',
          data: {
            chatGuid: 'iMessage;-;+15551234567',
            chat: {
              guid: 'iMessage;-;+15551234567',
              displayName: 'Jeff',
              participants: [{ address: '+15551234567' }],
            },
            message: {
              guid: 'owner-distinct-repeat-1',
              body: 'Yes, please pick them up.',
              senderName: 'Jeff',
              isFromMe: true,
              handle: { address: '+15551234567', displayName: 'Jeff' },
              dateCreated: new Date().toISOString(),
            },
          },
        }),
      });
      expect(distinctOwnerMessage.status).toBe(200);
      expect(onMessage).toHaveBeenCalledTimes(1);
      expect(onMessage).toHaveBeenCalledWith(
        'bb:iMessage;-;+15551234567',
        expect.objectContaining({
          provider_message_id: 'bb:owner-distinct-repeat-1',
          content: 'Yes, please pick them up.',
        }),
      );
    } finally {
      await channel.disconnect();
      await apiStub.close();
      if (previousCanonical == null) {
        delete process.env.BLUEBUBBLES_CANONICAL_SELF_THREAD_JID;
      } else {
        process.env.BLUEBUBBLES_CANONICAL_SELF_THREAD_JID = previousCanonical;
      }
    }
  });

  it('suppresses an idempotency-keyed provider echo that races ahead of the send response', async () => {
    const previousCanonical = process.env.BLUEBUBBLES_CANONICAL_SELF_THREAD_JID;
    process.env.BLUEBUBBLES_CANONICAL_SELF_THREAD_JID =
      'iMessage;-;+15551234567';
    let webhookUrl = '';
    const racedWebhookResponses: Array<{ status: number; body: string }> = [];
    const apiStub = await startBlueBubblesApiStub(async (req, _body, res) => {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      if ((req.url || '').startsWith('/api/v1/message/text')) {
        const raced = await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'new-message',
            data: {
              chatGuid: 'iMessage;-;+15551234567',
              chat: {
                guid: 'iMessage;-;+15551234567',
                displayName: 'Jeff',
                participants: [{ address: '+15551234567' }],
              },
              message: {
                guid: 'provider-raced-echo-1',
                body: 'Race-safe outbound text.',
                senderName: 'Jeff',
                isFromMe: true,
                handle: {
                  address: '+15551234567',
                  displayName: 'Jeff',
                },
                dateCreated: new Date().toISOString(),
              },
            },
          }),
        });
        racedWebhookResponses.push({
          status: raced.status,
          body: await raced.text(),
        });
        res.end(JSON.stringify({ data: { guid: 'provider-raced-echo-1' } }));
        return;
      }
      res.end(JSON.stringify({ data: [] }));
    });
    const onMessage = vi.fn();
    const channel = new BlueBubblesChannel(
      buildConfig({
        baseUrl: apiStub.baseUrl,
        chatScope: 'all_synced',
        allowedChatGuids: [],
        allowedChatGuid: null,
      }),
      {
        onMessage,
        onChatMetadata: vi.fn(),
        registeredGroups: () => ({}),
        onHealthUpdate: vi.fn(),
      },
    );

    try {
      await channel.connect();
      webhookUrl = channel.getWebhookUrl();
      await channel.sendMessage(
        'bb:iMessage;-;+15551234567',
        'Race-safe outbound text.',
        {
          suppressSenderLabel: true,
          idempotencyKey: 'message-action:race-safe-1',
        },
      );
      expect(racedWebhookResponses).toEqual([
        {
          status: 202,
          body: 'Ignored provider-correlated outbound echo',
        },
      ]);
      expect(onMessage).not.toHaveBeenCalled();
    } finally {
      await channel.disconnect();
      await apiStub.close();
      if (previousCanonical == null) {
        delete process.env.BLUEBUBBLES_CANONICAL_SELF_THREAD_JID;
      } else {
        process.env.BLUEBUBBLES_CANONICAL_SELF_THREAD_JID = previousCanonical;
      }
    }
  });

  it('suppresses captioned and attachment-only echoes that race ahead of attachment receipts', async () => {
    let webhookUrl = '';
    const attachmentBodies: string[] = [];
    const racedWebhookResponses: Array<{ status: number; body: string }> = [];
    const apiStub = await startBlueBubblesApiStub(async (req, body, res) => {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      if ((req.url || '').startsWith('/api/v1/message/attachment')) {
        attachmentBodies.push(body);
        const index = attachmentBodies.length;
        const caption = index === 1 ? 'Race-safe artifact caption.' : undefined;
        const raced = await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'new-message',
            data: {
              chatGuid: 'iMessage;-;fixture-chat-1',
              chat: {
                guid: 'iMessage;-;fixture-chat-1',
                displayName: 'Owner',
                participants: [{ address: '+15551234567' }],
              },
              message: {
                guid: `provider-raced-artifact-${index}`,
                ...(caption ? { body: caption } : {}),
                senderName: 'Owner',
                isFromMe: true,
                handle: {
                  address: '+15551234567',
                  displayName: 'Owner',
                },
                dateCreated: new Date().toISOString(),
                attachments: [
                  {
                    guid: `provider-raced-attachment-${index}`,
                    mimeType: 'text/plain',
                    transferName: 'echo-proof.txt',
                  },
                ],
              },
            },
          }),
        });
        racedWebhookResponses.push({
          status: raced.status,
          body: await raced.text(),
        });
        res.end(
          JSON.stringify({
            data: { guid: `provider-raced-artifact-${index}` },
          }),
        );
        return;
      }
      res.end(JSON.stringify({ data: [] }));
    });
    const onMessage = vi.fn();
    const channel = new BlueBubblesChannel(
      buildConfig({
        baseUrl: apiStub.baseUrl,
        chatScope: 'all_synced',
        allowedChatGuids: [],
        allowedChatGuid: null,
      }),
      {
        onMessage,
        onChatMetadata: vi.fn(),
        registeredGroups: () => ({}),
        onHealthUpdate: vi.fn(),
      },
    );
    const artifact = {
      kind: 'file' as const,
      filename: 'echo-proof.txt',
      mimeType: 'text/plain',
      bytesBase64: Buffer.from('proof').toString('base64'),
    };

    try {
      await channel.connect();
      webhookUrl = channel.getWebhookUrl();
      await channel.sendArtifact('bb:iMessage;-;fixture-chat-1', artifact, {
        caption: 'Race-safe artifact caption.',
        idempotencyKey: 'artifact-action:race-safe-captioned',
      });
      await channel.sendArtifact('bb:iMessage;-;fixture-chat-1', artifact, {
        idempotencyKey: 'artifact-action:race-safe-attachment-only',
      });

      expect(racedWebhookResponses).toEqual([
        {
          status: 202,
          body: 'Ignored provider-correlated outbound echo',
        },
        {
          status: 202,
          body: 'Ignored provider-correlated outbound echo',
        },
      ]);
      expect(onMessage).not.toHaveBeenCalled();
      expect(attachmentBodies[0]).toContain(
        'artifact-action:race-safe-captioned',
      );
      expect(attachmentBodies[1]).toContain(
        'artifact-action:race-safe-attachment-only',
      );
      const storedArtifacts = listRecentMessagesForChat(
        'bb:iMessage;-;fixture-chat-1',
        10,
      ).filter((message) =>
        message.id.startsWith('bb:provider-raced-artifact-'),
      );
      expect(
        storedArtifacts.map((message) => message.provider_idempotency_key),
      ).toEqual([
        'artifact-action:race-safe-attachment-only',
        'artifact-action:race-safe-captioned',
      ]);
    } finally {
      await channel.disconnect();
      await apiStub.close();
    }
  });

  it('carries signed-webhook authorship into the outbound boundary and ignores an isFromMe:false send command without provider work', async () => {
    const previousDisable = process.env.ANDREA_TEST_DISABLE_OWNER_ENV_FILE;
    const previousCanonical = process.env.BLUEBUBBLES_CANONICAL_SELF_THREAD_JID;
    process.env.ANDREA_TEST_DISABLE_OWNER_ENV_FILE = '1';
    process.env.BLUEBUBBLES_CANONICAL_SELF_THREAD_JID =
      'iMessage;-;owner@example.invalid';

    const providerPostPaths: string[] = [];
    const apiStub = await startBlueBubblesApiStub(async (req, _body, res) => {
      if ((req.method || 'GET').toUpperCase() === 'POST') {
        providerPostPaths.push(req.url || '');
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      if ((req.url || '').startsWith('/api/v1/server/info')) {
        res.end(JSON.stringify({ data: { private_api: true } }));
        return;
      }
      res.end(JSON.stringify({ data: [] }));
    });
    const providerSend = vi.fn(async () => ({
      platformMessageId: 'bb:offline-signed-webhook-receipt',
    }));
    const refreshControlState =
      vi.fn<() => Promise<BlueBubblesChannelControlSnapshot>>();
    const companionGroup: RegisteredGroup = {
      name: 'BlueBubbles (Main)',
      folder: 'main',
      trigger: '@Andrea',
      added_at: '2026-07-16T00:00:00.000Z',
      requiresTrigger: false,
      isMain: false,
    };
    const results: Awaited<
      ReturnType<typeof executeBlueBubblesOutboundTurn>
    >[] = [];
    const channel = new BlueBubblesChannel(
      buildConfig({
        baseUrl: apiStub.baseUrl,
        chatScope: 'allowlist',
        allowedChatGuids: ['iMessage;-;owner@example.invalid'],
        allowedChatGuid: 'iMessage;-;owner@example.invalid',
      }),
      {
        onMessage: async (chatJid, message) => {
          const result = await executeBlueBubblesOutboundTurn({
            groupFolder: 'main',
            channel: 'bluebubbles',
            chatJid,
            group: companionGroup,
            ownerAuthored: message.is_from_me === true,
            rawText: message.content,
            inboundMessageId: message.id,
            blueBubblesChannel: {
              getControlSnapshot: () => channel.getControlSnapshot(),
              refreshControlState,
            },
            resolveStoredRecipient: () => ({
              state: 'resolved',
              target: {
                chatJid: 'bb:iMessage;-;+12025550123',
                displayName: 'Travis Story',
                isGroup: false,
              },
            }),
            resolveLiveRecipient: async () => ({ state: 'missing' }),
            executionDeps: {
              groupFolder: 'main',
              channel: 'bluebubbles',
              chatJid,
              sendToTarget: providerSend,
            },
          });
          results.push(result);
        },
        onChatMetadata: vi.fn(),
        registeredGroups: () => ({
          'bb:iMessage;-;owner@example.invalid': companionGroup,
        }),
        onHealthUpdate: vi.fn(),
      },
    );

    try {
      await channel.connect();
      refreshControlState.mockImplementation(async () =>
        channel.getControlSnapshot(),
      );
      const signedWebhookUrl = channel.getWebhookUrl();
      const payload = (
        guid: string,
        isFromMe: boolean,
        dateCreated: string,
      ) => ({
        type: 'new-message',
        data: {
          guid,
          text: 'Text Travis Story: Dinner is ready.',
          dateCreated,
          isFromMe,
          handle: {
            address: 'owner@example.invalid',
            displayName: 'Owner',
            service: 'iMessage',
          },
          chats: [
            {
              guid: 'iMessage;-;owner@example.invalid',
              displayName: 'Owner self-thread',
              isGroup: false,
              participants: [{ address: 'owner@example.invalid' }],
            },
          ],
        },
      });

      const untrusted = await fetch(signedWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          payload('signed-owner-command-false', false, '2026-07-16T12:00:00Z'),
        ),
      });

      expect(untrusted.status).toBe(200);
      expect(results).toEqual([
        expect.objectContaining({ handled: true, state: 'restricted' }),
      ]);
      expect(providerPostPaths).toEqual([]);
      expect(providerSend).not.toHaveBeenCalled();
      expect(refreshControlState).not.toHaveBeenCalled();
      expect(
        listMessageActionsForGroup({ groupFolder: 'main', includeSent: true }),
      ).toHaveLength(0);

      const trusted = await fetch(signedWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          payload('signed-owner-command-true', true, '2026-07-16T12:00:10Z'),
        ),
      });

      expect(trusted.status).toBe(200);
      expect(results.at(-1)).toMatchObject({
        handled: true,
        state: 'staged',
        action: {
          sendStatus: 'drafted',
          requiresApproval: true,
          draftText: 'Dinner is ready.',
        },
      });
      expect(refreshControlState).toHaveBeenCalledTimes(1);
      expect(providerSend).not.toHaveBeenCalled();
      expect(providerPostPaths).toEqual([]);
      const [stagedAction] = listMessageActionsForGroup({
        groupFolder: 'main',
        includeSent: true,
      });
      expect(stagedAction).toMatchObject({
        sendStatus: 'drafted',
        requiresApproval: true,
      });
      if (!stagedAction) throw new Error('expected a staged message action');

      updateMessageAction(stagedAction.messageActionId, {
        presentationMessageId: 'bb:fresh-owner-approval-card',
        lastUpdatedAt: '2026-07-16T12:00:20.000Z',
      });
      const approved = await applyMessageActionOperation(
        stagedAction.messageActionId,
        { kind: 'send' },
        {
          groupFolder: 'main',
          channel: 'bluebubbles',
          chatJid: 'bb:iMessage;-;owner@example.invalid',
          currentTime: new Date('2026-07-16T12:00:30.000Z'),
          sendToTarget: providerSend,
        },
      );

      expect(approved.action).toMatchObject({
        sendStatus: 'sent',
        platformMessageId: 'bb:offline-signed-webhook-receipt',
      });
      expect(providerSend).toHaveBeenCalledTimes(1);
      expect(providerPostPaths).toEqual([]);
    } finally {
      await channel.disconnect();
      await apiStub.close();
      if (previousDisable == null) {
        delete process.env.ANDREA_TEST_DISABLE_OWNER_ENV_FILE;
      } else {
        process.env.ANDREA_TEST_DISABLE_OWNER_ENV_FILE = previousDisable;
      }
      if (previousCanonical == null) {
        delete process.env.BLUEBUBBLES_CANONICAL_SELF_THREAD_JID;
      } else {
        process.env.BLUEBUBBLES_CANONICAL_SELF_THREAD_JID = previousCanonical;
      }
    }
  });

  it('delivers correlated self-authored webhook evidence outside inbound chat scope without routing it as inbound text', async () => {
    const apiStub = await startBlueBubblesApiStub(async (_req, _body, res) => {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: [] }));
    });
    const onMessage = vi.fn();
    const receiptInboxDatabasePath = path.join(
      tempProjectRoot,
      'correlated-receipts.sqlite3',
    );
    const channel = new BlueBubblesChannel(
      buildConfig({
        baseUrl: apiStub.baseUrl,
        receiptInboxDatabasePath,
      }),
      {
        onMessage,
        onChatMetadata: vi.fn(),
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
            guid: 'provider-message-evidence-1',
            tempGuid: 'message-action:stable-provider-key-1',
            text: 'Andrea: Hi from Andrea — 👋🏽',
            dateCreated: '2026-04-05T13:00:00.000Z',
            isFromMe: true,
            handle: { address: '+15551234567' },
            chats: [
              {
                guid: 'iMessage;-;+15551234567',
                participants: [{ address: '+15551234567' }],
              },
            ],
          },
        }),
      });

      expect(response.status).toBe(200);
      expect(await response.text()).toBe(
        'Persisted outbound delivery evidence',
      );
      const inspection = new BlueBubblesReceiptInboxStore(
        receiptInboxDatabasePath,
      );
      expect(inspection.listPendingReceipts()).toEqual([
        expect.objectContaining({
          messageGuid: 'provider-message-evidence-1',
          chatGuid: 'iMessage;-;+15551234567',
          content: 'Andrea: Hi from Andrea — 👋🏽',
          isFromMe: true,
          tempGuid: 'message-action:stable-provider-key-1',
        }),
      ]);
      inspection.close();
      expect(onMessage).not.toHaveBeenCalled();
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
          chatGuid: 'iMessage;-;+12025550101',
          chat: {
            guid: 'iMessage;-;+12025550101',
            displayName: 'Jeff',
            participants: [{ address: '+12025550101' }],
            isGroup: false,
          },
          message: {
            body: '@Andrea help',
            senderName: 'Jeff',
            isFromMe: true,
            handle: { address: '+12025550101', displayName: 'Jeff' },
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

  it('suppresses one physical self-thread message mirrored across phone and email aliases', async () => {
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
    const previousCanonical = process.env.BLUEBUBBLES_CANONICAL_SELF_THREAD_JID;
    const previousAliases = process.env.BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS;
    process.env.BLUEBUBBLES_CANONICAL_SELF_THREAD_JID =
      'iMessage;-;owner@example.invalid';
    process.env.BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS =
      'iMessage;-;+12025550109,iMessage;-;owner@example.invalid';
    const receiptInboxDatabasePath = path.join(
      tempProjectRoot,
      'durable-self-thread-claims.sqlite3',
    );
    const config = buildConfig({
      baseUrl: apiStub.baseUrl,
      chatScope: 'all_synced',
      allowedChatGuids: [],
      allowedChatGuid: null,
      receiptInboxDatabasePath,
    });
    const opts = {
      onMessage,
      onChatMetadata: vi.fn(
        async (
          chatJid: string,
          timestamp: string,
          name?: string,
          channelName?: string,
          isGroup?: boolean,
        ) => {
          storeChatMetadata(chatJid, timestamp, name, channelName, isGroup);
        },
      ),
      registeredGroups: () => ({}),
      onHealthUpdate: vi.fn(),
    };
    let channel = new BlueBubblesChannel(config, opts);

    try {
      await channel.connect();
      let webhookUrl = channel.getWebhookUrl();
      const sendAliasWebhook = (input: {
        chatGuid: string;
        messageGuid: string;
        handle: string;
        timestamp: string;
      }) =>
        fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'new-message',
            data: {
              chatGuid: input.chatGuid,
              chat: {
                guid: input.chatGuid,
                displayName: 'Owner',
                participants: [{ address: input.handle }],
                isGroup: false,
              },
              message: {
                guid: input.messageGuid,
                body: '@Andrea check status',
                senderName: 'Owner',
                isFromMe: true,
                handle: { address: input.handle, displayName: 'Owner' },
                dateCreated: input.timestamp,
              },
            },
          }),
        });

      const first = await sendAliasWebhook({
        chatGuid: 'iMessage;-;+12025550109',
        messageGuid: 'mirrored-phone-guid',
        handle: '+12025550109',
        timestamp: '2026-04-12T20:08:00.000Z',
      });
      const firstMessage = onMessage.mock.calls[0]?.[1];
      expect(firstMessage).toMatchObject({
        id: firstMessage?.durable_ingress_claim_id,
        provider_message_id: 'bb:mirrored-phone-guid',
        ingress_received_at: expect.any(String),
      });
      expect(firstMessage?.ingress_received_at).not.toBe(
        firstMessage?.timestamp,
      );

      await channel.disconnect();
      channel = new BlueBubblesChannel(config, opts);
      await channel.connect();
      webhookUrl = channel.getWebhookUrl();
      const mirrored = await sendAliasWebhook({
        chatGuid: 'iMessage;-;owner@example.invalid',
        messageGuid: 'mirrored-email-guid',
        handle: 'owner@example.invalid',
        timestamp: '2026-04-12T20:08:00.500Z',
      });
      const intentionalRepeat = await sendAliasWebhook({
        chatGuid: 'iMessage;-;+12025550109',
        messageGuid: 'intentional-repeat-guid',
        handle: '+12025550109',
        timestamp: '2026-04-12T20:08:03.000Z',
      });

      expect(first.status).toBe(200);
      expect(mirrored.status).toBe(202);
      expect(await mirrored.text()).toBe('Ignored durable mirrored delivery');
      expect(intentionalRepeat.status).toBe(200);
      expect(onMessage).toHaveBeenCalledTimes(2);
      expect(onMessage.mock.calls[1]?.[1]?.id).not.toBe(firstMessage?.id);
    } finally {
      await channel.disconnect();
      await apiStub.close();
      if (previousCanonical == null) {
        delete process.env.BLUEBUBBLES_CANONICAL_SELF_THREAD_JID;
      } else {
        process.env.BLUEBUBBLES_CANONICAL_SELF_THREAD_JID = previousCanonical;
      }
      if (previousAliases == null) {
        delete process.env.BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS;
      } else {
        process.env.BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS = previousAliases;
      }
    }
  });

  it('accepts a cross-alias crash-resume claim without rerunning a main-store-accepted turn', async () => {
    const previousCanonical = process.env.BLUEBUBBLES_CANONICAL_SELF_THREAD_JID;
    const previousAliases = process.env.BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS;
    process.env.BLUEBUBBLES_CANONICAL_SELF_THREAD_JID =
      'iMessage;-;owner@example.invalid';
    process.env.BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS =
      'iMessage;-;+12025550109,iMessage;-;owner@example.invalid';
    const receiptInboxDatabasePath = path.join(
      tempProjectRoot,
      'crash-after-main-store.sqlite3',
    );
    const claimStore = new BlueBubblesReceiptInboxStore(
      receiptInboxDatabasePath,
    );
    const interrupted = claimStore.claimCanonicalSelfThreadIngress({
      canonicalScope: 'bb:iMessage;-;owner@example.invalid',
      ownerAuthored: true,
      body: '@Andrea recover after crash',
      providerTimestamp: '2026-07-16T12:00:00.000Z',
      now: new Date(Date.now() - 60_000),
      processingLeaseMs: 100,
    });
    claimStore.close();
    storeChatMetadata(
      'bb:iMessage;-;+12025550109',
      '2026-07-16T12:00:00.000Z',
      'Owner',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: interrupted.claimId,
      chat_jid: 'bb:iMessage;-;+12025550109',
      sender: 'bb:+12025550109',
      sender_name: 'Owner',
      content: '@Andrea recover after crash',
      timestamp: '2026-07-16T12:00:00.000Z',
      is_from_me: true,
      is_bot_message: false,
    });
    const apiStub = await startBlueBubblesApiStub(async (_req, _body, res) => {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: [] }));
    });
    const onMessage = vi.fn();
    const channel = new BlueBubblesChannel(
      buildConfig({
        baseUrl: apiStub.baseUrl,
        chatScope: 'all_synced',
        allowedChatGuids: [],
        allowedChatGuid: null,
        receiptInboxDatabasePath,
      }),
      {
        onMessage,
        onChatMetadata: vi.fn(),
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
            guid: 'crash-resume-email-guid',
            text: '@Andrea recover after crash',
            dateCreated: '2026-07-16T12:00:00.500Z',
            isFromMe: true,
            handle: {
              address: 'owner@example.invalid',
              displayName: 'Owner',
            },
            chats: [
              {
                guid: 'iMessage;-;owner@example.invalid',
                isGroup: false,
                participants: [{ address: 'owner@example.invalid' }],
              },
            ],
          },
        }),
      });

      expect(response.status).toBe(202);
      expect(await response.text()).toBe(
        'Ignored already accepted durable delivery',
      );
      expect(onMessage).not.toHaveBeenCalled();
      const inspection = new BlueBubblesReceiptInboxStore(
        receiptInboxDatabasePath,
      );
      const accepted = inspection.claimCanonicalSelfThreadIngress({
        canonicalScope: 'bb:iMessage;-;owner@example.invalid',
        ownerAuthored: true,
        body: '@Andrea recover after crash',
        providerTimestamp: '2026-07-16T12:00:00.250Z',
        now: new Date('2030-01-01T00:00:00.000Z'),
      });
      expect(accepted).toMatchObject({
        claimId: interrupted.claimId,
        disposition: 'mirror',
        shouldProcess: false,
        acceptedAt: expect.any(String),
      });
      inspection.close();
    } finally {
      await channel.disconnect();
      await apiStub.close();
      if (previousCanonical == null) {
        delete process.env.BLUEBUBBLES_CANONICAL_SELF_THREAD_JID;
      } else {
        process.env.BLUEBUBBLES_CANONICAL_SELF_THREAD_JID = previousCanonical;
      }
      if (previousAliases == null) {
        delete process.env.BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS;
      } else {
        process.env.BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS = previousAliases;
      }
    }
  });

  it('terminally ignores an old sidecar claim redelivered through the live webhook', async () => {
    const previousCanonical = process.env.BLUEBUBBLES_CANONICAL_SELF_THREAD_JID;
    const previousAliases = process.env.BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS;
    process.env.BLUEBUBBLES_CANONICAL_SELF_THREAD_JID =
      'iMessage;-;owner@example.invalid';
    process.env.BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS =
      'iMessage;-;+12025550109,iMessage;-;owner@example.invalid';
    const receiptInboxDatabasePath = path.join(
      tempProjectRoot,
      'stale-live-redelivery-claim.sqlite3',
    );
    const providerTimestampMs = Date.now() - 1_000;
    const claimStore = new BlueBubblesReceiptInboxStore(
      receiptInboxDatabasePath,
    );
    const staleClaim = claimStore.claimCanonicalSelfThreadIngress({
      canonicalScope: 'bb:iMessage;-;owner@example.invalid',
      ownerAuthored: true,
      body: '@Andrea do not replay this old turn',
      providerTimestamp: new Date(providerTimestampMs).toISOString(),
      now: new Date(Date.now() - 20 * 60 * 1_000),
      processingLeaseMs: 100,
    });
    claimStore.close();
    const apiStub = await startBlueBubblesApiStub(async (_req, _body, res) => {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: [] }));
    });
    const onMessage = vi.fn();
    const onChatMetadata = vi.fn();
    const channel = new BlueBubblesChannel(
      buildConfig({
        baseUrl: apiStub.baseUrl,
        chatScope: 'all_synced',
        allowedChatGuids: [],
        allowedChatGuid: null,
        receiptInboxDatabasePath,
      }),
      {
        onMessage,
        onChatMetadata,
        registeredGroups: () => ({}),
        onHealthUpdate: vi.fn(),
      },
    );

    const payload = JSON.stringify({
      type: 'new-message',
      data: {
        guid: 'stale-live-redelivery-guid',
        text: '@Andrea do not replay this old turn',
        dateCreated: new Date(providerTimestampMs + 500).toISOString(),
        isFromMe: true,
        handle: {
          address: 'owner@example.invalid',
          displayName: 'Owner',
        },
        chats: [
          {
            guid: 'iMessage;-;owner@example.invalid',
            isGroup: false,
            participants: [{ address: 'owner@example.invalid' }],
          },
        ],
      },
    });

    try {
      await channel.connect();
      const first = await fetch(channel.getWebhookUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      });
      const repeated = await fetch(channel.getWebhookUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      });

      expect(first.status).toBe(202);
      expect(await first.text()).toBe('Ignored stale durable ingress claim');
      expect(repeated.status).toBe(202);
      expect(await repeated.text()).toBe('Ignored durable mirrored delivery');
      expect(onMessage).not.toHaveBeenCalled();
      expect(onChatMetadata).not.toHaveBeenCalled();
      const inspection = new BlueBubblesReceiptInboxStore(
        receiptInboxDatabasePath,
      );
      expect(
        inspection.claimCanonicalSelfThreadIngress({
          canonicalScope: 'bb:iMessage;-;owner@example.invalid',
          ownerAuthored: true,
          body: '@Andrea do not replay this old turn',
          providerTimestamp: new Date(providerTimestampMs + 250).toISOString(),
        }),
      ).toMatchObject({
        claimId: staleClaim.claimId,
        claimedAt: staleClaim.claimedAt,
        disposition: 'mirror',
        shouldProcess: false,
        acceptedAt: expect.any(String),
      });
      inspection.close();
    } finally {
      await channel.disconnect();
      await apiStub.close();
      if (previousCanonical == null) {
        delete process.env.BLUEBUBBLES_CANONICAL_SELF_THREAD_JID;
      } else {
        process.env.BLUEBUBBLES_CANONICAL_SELF_THREAD_JID = previousCanonical;
      }
      if (previousAliases == null) {
        delete process.env.BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS;
      } else {
        process.env.BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS = previousAliases;
      }
    }
  });

  it('suppresses accepted self-thread alias replays during restart history priming', async () => {
    const previousCanonical = process.env.BLUEBUBBLES_CANONICAL_SELF_THREAD_JID;
    const previousAliases = process.env.BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS;
    process.env.BLUEBUBBLES_CANONICAL_SELF_THREAD_JID =
      'iMessage;-;owner@example.invalid';
    process.env.BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS =
      'iMessage;-;+12025550109,iMessage;-;owner@example.invalid';
    const receiptInboxDatabasePath = path.join(
      tempProjectRoot,
      'restart-history-alias-claims.sqlite3',
    );
    const apiStub = await startBlueBubblesApiStub(async (req, _body, res) => {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      if ((req.url || '').startsWith('/api/v1/server/info')) {
        res.end(JSON.stringify({ data: { private_api: true } }));
        return;
      }
      if ((req.url || '').startsWith('/api/v1/message')) {
        res.end(
          JSON.stringify({
            data: [
              {
                guid: 'history-mirrored-email-guid',
                text: '@Andrea send the approved update',
                senderName: 'Owner',
                isFromMe: true,
                handle: {
                  address: 'owner@example.invalid',
                  displayName: 'Owner',
                },
                dateCreated: '2026-07-16T12:00:00.500Z',
                chats: [
                  {
                    guid: 'iMessage;-;owner@example.invalid',
                    isGroup: false,
                    participants: [{ address: 'owner@example.invalid' }],
                  },
                ],
              },
              {
                guid: 'history-intentional-repeat-guid',
                text: '@Andrea send the approved update',
                senderName: 'Owner',
                isFromMe: true,
                handle: {
                  address: 'owner@example.invalid',
                  displayName: 'Owner',
                },
                dateCreated: '2026-07-16T12:00:03.000Z',
                chats: [
                  {
                    guid: 'iMessage;-;owner@example.invalid',
                    isGroup: false,
                    participants: [{ address: 'owner@example.invalid' }],
                  },
                ],
              },
            ],
          }),
        );
        return;
      }
      res.end(JSON.stringify({ data: [] }));
    });
    const onMessage = vi.fn(async (_chatJid, message) => {
      storeMessage(message);
    });
    const config = buildConfig({
      baseUrl: apiStub.baseUrl,
      chatScope: 'all_synced',
      allowedChatGuids: [],
      allowedChatGuid: null,
      receiptInboxDatabasePath,
    });
    const opts = {
      onMessage,
      onChatMetadata: vi.fn(
        async (
          chatJid: string,
          timestamp: string,
          name?: string,
          channelName?: string,
          isGroup?: boolean,
        ) => {
          storeChatMetadata(chatJid, timestamp, name, channelName, isGroup);
        },
      ),
      registeredGroups: () => ({}),
      onHealthUpdate: vi.fn(),
    };
    let channel = new BlueBubblesChannel(config, opts);

    try {
      await channel.connect();
      const live = await fetch(channel.getWebhookUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'new-message',
          data: {
            guid: 'live-phone-guid',
            text: '@Andrea send the approved update',
            dateCreated: '2026-07-16T12:00:00.000Z',
            isFromMe: true,
            handle: { address: '+12025550109', displayName: 'Owner' },
            chats: [
              {
                guid: 'iMessage;-;+12025550109',
                isGroup: false,
                participants: [{ address: '+12025550109' }],
              },
            ],
          },
        }),
      });
      expect(live.status).toBe(200);
      expect(onMessage).toHaveBeenCalledTimes(1);
      const acceptedClaimId = onMessage.mock.calls[0]?.[1]?.id;

      await channel.disconnect();
      channel = new BlueBubblesChannel(config, opts);
      await channel.connect();
      const primed = await channel.primeRecentHistory({
        limit: 20,
        recoverUnacceptedClaims: true,
      });
      const repeated = await channel.primeRecentHistory({
        limit: 20,
        recoverUnacceptedClaims: true,
      });

      expect(primed).toEqual({ storedCount: 0, totalCount: 2 });
      expect(repeated).toEqual({ storedCount: 0, totalCount: 2 });
      expect(onMessage).toHaveBeenCalledTimes(1);
      const canonicalRows = listRecentMessagesForChat(
        'bb:iMessage;-;owner@example.invalid',
        10,
      );
      expect(canonicalRows).toEqual([]);
      expect(acceptedClaimId).toEqual(expect.any(String));
    } finally {
      await channel.disconnect();
      await apiStub.close();
      if (previousCanonical == null) {
        delete process.env.BLUEBUBBLES_CANONICAL_SELF_THREAD_JID;
      } else {
        process.env.BLUEBUBBLES_CANONICAL_SELF_THREAD_JID = previousCanonical;
      }
      if (previousAliases == null) {
        delete process.env.BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS;
      } else {
        process.env.BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS = previousAliases;
      }
    }
  });

  it('routes a locally fresh recovery claim even when the provider timestamp is stale', async () => {
    const previousCanonical = process.env.BLUEBUBBLES_CANONICAL_SELF_THREAD_JID;
    const previousAliases = process.env.BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS;
    process.env.BLUEBUBBLES_CANONICAL_SELF_THREAD_JID =
      'iMessage;-;owner@example.invalid';
    process.env.BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS =
      'iMessage;-;+12025550109,iMessage;-;owner@example.invalid';
    const receiptInboxDatabasePath = path.join(
      tempProjectRoot,
      'expired-history-recovery-claim.sqlite3',
    );
    // Provider clocks are evidence for mirror matching, never the recovery
    // authorization clock. Only the sidecar's immutable claimedAt is fresh.
    const providerTimestampMs = Date.now() - 24 * 60 * 60 * 1_000;
    const providerTimestamp = new Date(providerTimestampMs).toISOString();
    const mirroredProviderTimestamp = new Date(
      providerTimestampMs + 500,
    ).toISOString();
    const claimStore = new BlueBubblesReceiptInboxStore(
      receiptInboxDatabasePath,
    );
    const interrupted = claimStore.claimCanonicalSelfThreadIngress({
      canonicalScope: 'bb:iMessage;-;owner@example.invalid',
      ownerAuthored: true,
      body: '@Andrea recover this interrupted turn',
      providerTimestamp,
      now: new Date(Date.now() - 60_000),
      processingLeaseMs: 100,
    });
    claimStore.close();
    const apiStub = await startBlueBubblesApiStub(async (req, _body, res) => {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      if ((req.url || '').startsWith('/api/v1/server/info')) {
        res.end(JSON.stringify({ data: { private_api: true } }));
        return;
      }
      if ((req.url || '').startsWith('/api/v1/message')) {
        res.end(
          JSON.stringify({
            data: [
              {
                guid: 'recovered-history-provider-guid',
                text: '@Andrea recover this interrupted turn',
                senderName: 'Owner',
                isFromMe: true,
                handle: {
                  address: 'owner@example.invalid',
                  displayName: 'Owner',
                },
                dateCreated: mirroredProviderTimestamp,
                chats: [
                  {
                    guid: 'iMessage;-;owner@example.invalid',
                    isGroup: false,
                    participants: [{ address: 'owner@example.invalid' }],
                  },
                ],
              },
            ],
          }),
        );
        return;
      }
      res.end(JSON.stringify({ data: [] }));
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
        receiptInboxDatabasePath,
      }),
      {
        onMessage,
        onChatMetadata: vi.fn(),
        registeredGroups: () => ({}),
        onHealthUpdate: vi.fn(),
      },
    );

    try {
      await channel.connect();
      const primed = await channel.primeRecentHistory({
        limit: 20,
        recoverUnacceptedClaims: true,
      });

      expect(primed).toEqual({ storedCount: 1, totalCount: 1 });
      expect(onMessage).toHaveBeenCalledTimes(1);
      expect(onMessage.mock.calls[0]?.[1]).toMatchObject({
        id: interrupted.claimId,
        durable_ingress_claim_id: interrupted.claimId,
        provider_message_id: 'bb:recovered-history-provider-guid',
        ingress_received_at: interrupted.claimedAt,
      });
      const inspection = new BlueBubblesReceiptInboxStore(
        receiptInboxDatabasePath,
      );
      const accepted = inspection.claimCanonicalSelfThreadIngress({
        canonicalScope: 'bb:iMessage;-;owner@example.invalid',
        ownerAuthored: true,
        body: '@Andrea recover this interrupted turn',
        providerTimestamp: new Date(providerTimestampMs + 250).toISOString(),
      });
      expect(accepted).toMatchObject({
        claimId: interrupted.claimId,
        disposition: 'mirror',
        shouldProcess: false,
        acceptedAt: expect.any(String),
      });
      inspection.close();
    } finally {
      await channel.disconnect();
      await apiStub.close();
      if (previousCanonical == null) {
        delete process.env.BLUEBUBBLES_CANONICAL_SELF_THREAD_JID;
      } else {
        process.env.BLUEBUBBLES_CANONICAL_SELF_THREAD_JID = previousCanonical;
      }
      if (previousAliases == null) {
        delete process.env.BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS;
      } else {
        process.env.BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS = previousAliases;
      }
    }
  });

  it('terminally ignores an old local claim even when provider history looks fresh', async () => {
    const previousCanonical = process.env.BLUEBUBBLES_CANONICAL_SELF_THREAD_JID;
    const previousAliases = process.env.BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS;
    process.env.BLUEBUBBLES_CANONICAL_SELF_THREAD_JID =
      'iMessage;-;owner@example.invalid';
    process.env.BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS =
      'iMessage;-;+12025550109,iMessage;-;owner@example.invalid';
    const receiptInboxDatabasePath = path.join(
      tempProjectRoot,
      'stale-history-recovery-claim.sqlite3',
    );
    const claimStore = new BlueBubblesReceiptInboxStore(
      receiptInboxDatabasePath,
    );
    const providerTimestampMs = Date.now() - 1_000;
    const providerTimestamp = new Date(providerTimestampMs).toISOString();
    const staleClaim = claimStore.claimCanonicalSelfThreadIngress({
      canonicalScope: 'bb:iMessage;-;owner@example.invalid',
      ownerAuthored: true,
      body: '@Andrea this stale turn must remain inert',
      // Adversarial provider evidence is fresh, while the authoritative local
      // receipt is older than the bounded recovery window.
      providerTimestamp,
      now: new Date(Date.now() - 20 * 60 * 1_000),
      processingLeaseMs: 100,
    });
    claimStore.close();
    const apiStub = await startBlueBubblesApiStub(async (req, _body, res) => {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      if ((req.url || '').startsWith('/api/v1/server/info')) {
        res.end(JSON.stringify({ data: { private_api: true } }));
        return;
      }
      if ((req.url || '').startsWith('/api/v1/message')) {
        res.end(
          JSON.stringify({
            data: [
              {
                guid: 'stale-recovered-history-provider-guid',
                text: '@Andrea this stale turn must remain inert',
                senderName: 'Owner',
                isFromMe: true,
                handle: {
                  address: 'owner@example.invalid',
                  displayName: 'Owner',
                },
                dateCreated: new Date(providerTimestampMs + 500).toISOString(),
                chats: [
                  {
                    guid: 'iMessage;-;owner@example.invalid',
                    isGroup: false,
                    participants: [{ address: 'owner@example.invalid' }],
                  },
                ],
              },
            ],
          }),
        );
        return;
      }
      res.end(JSON.stringify({ data: [] }));
    });
    const onMessage = vi.fn();
    const channel = new BlueBubblesChannel(
      buildConfig({
        baseUrl: apiStub.baseUrl,
        chatScope: 'all_synced',
        allowedChatGuids: [],
        allowedChatGuid: null,
        receiptInboxDatabasePath,
      }),
      {
        onMessage,
        onChatMetadata: vi.fn(),
        registeredGroups: () => ({}),
        onHealthUpdate: vi.fn(),
      },
    );

    try {
      await channel.connect();
      const primed = await channel.primeRecentHistory({
        limit: 20,
        recoverUnacceptedClaims: true,
      });
      const repeated = await channel.primeRecentHistory({
        limit: 20,
        recoverUnacceptedClaims: true,
      });

      expect(primed).toEqual({ storedCount: 0, totalCount: 1 });
      expect(repeated).toEqual({ storedCount: 0, totalCount: 1 });
      expect(onMessage).not.toHaveBeenCalled();
      expect(
        listRecentMessagesForChat('bb:iMessage;-;owner@example.invalid', 10),
      ).toEqual([]);
      const inspection = new BlueBubblesReceiptInboxStore(
        receiptInboxDatabasePath,
      );
      const terminal = inspection.claimCanonicalSelfThreadIngress({
        canonicalScope: 'bb:iMessage;-;owner@example.invalid',
        ownerAuthored: true,
        body: '@Andrea this stale turn must remain inert',
        providerTimestamp: new Date(providerTimestampMs + 250).toISOString(),
      });
      expect(terminal).toMatchObject({
        claimId: staleClaim.claimId,
        claimedAt: staleClaim.claimedAt,
        disposition: 'mirror',
        shouldProcess: false,
        acceptedAt: expect.any(String),
      });
      inspection.close();
    } finally {
      await channel.disconnect();
      await apiStub.close();
      if (previousCanonical == null) {
        delete process.env.BLUEBUBBLES_CANONICAL_SELF_THREAD_JID;
      } else {
        process.env.BLUEBUBBLES_CANONICAL_SELF_THREAD_JID = previousCanonical;
      }
      if (previousAliases == null) {
        delete process.env.BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS;
      } else {
        process.env.BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS = previousAliases;
      }
    }
  });

  it('fails configured owner ingress closed when the durable claim store is unavailable', async () => {
    const previousCanonical = process.env.BLUEBUBBLES_CANONICAL_SELF_THREAD_JID;
    const previousAliases = process.env.BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS;
    process.env.BLUEBUBBLES_CANONICAL_SELF_THREAD_JID =
      'iMessage;-;owner@example.invalid';
    process.env.BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS =
      'iMessage;-;owner@example.invalid';
    const apiStub = await startBlueBubblesApiStub(async (_req, _body, res) => {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: [] }));
    });
    const onMessage = vi.fn();
    const channel = new BlueBubblesChannel(
      buildConfig({
        baseUrl: apiStub.baseUrl,
        chatScope: 'all_synced',
        allowedChatGuids: [],
        allowedChatGuid: null,
      }),
      {
        onMessage,
        onChatMetadata: vi.fn(),
        registeredGroups: () => ({}),
        onHealthUpdate: vi.fn(),
      },
      {
        createReceiptInboxStore: () => {
          throw new Error('simulated durable store outage');
        },
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
            guid: 'store-outage-guid',
            text: '@Andrea do not trust volatile auth',
            dateCreated: '2026-07-16T12:00:00.000Z',
            isFromMe: true,
            handle: {
              address: 'owner@example.invalid',
              displayName: 'Owner',
            },
            chats: [
              {
                guid: 'iMessage;-;owner@example.invalid',
                isGroup: false,
                participants: [{ address: 'owner@example.invalid' }],
              },
            ],
          },
        }),
      });
      expect(response.status).toBe(503);
      expect(await response.text()).toBe('Durable ingress claim unavailable');
      expect(onMessage).not.toHaveBeenCalled();
    } finally {
      await channel.disconnect();
      await apiStub.close();
      if (previousCanonical == null) {
        delete process.env.BLUEBUBBLES_CANONICAL_SELF_THREAD_JID;
      } else {
        process.env.BLUEBUBBLES_CANONICAL_SELF_THREAD_JID = previousCanonical;
      }
      if (previousAliases == null) {
        delete process.env.BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS;
      } else {
        process.env.BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS = previousAliases;
      }
    }
  });

  it('rejects text and artifact sends before provider POST when the supervised receipt inbox is unavailable', async () => {
    let providerPostCount = 0;
    const apiStub = await startBlueBubblesApiStub(async (req, _body, res) => {
      if ((req.method || 'GET').toUpperCase() === 'POST') {
        providerPostCount += 1;
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: [] }));
    });
    const channel = new BlueBubblesChannel(
      buildConfig({
        baseUrl: apiStub.baseUrl,
        receiptInboxSupervisionRequired: true,
      }),
      {
        onMessage: vi.fn(),
        onChatMetadata: vi.fn(),
        registeredGroups: () => ({}),
        onHealthUpdate: vi.fn(),
      },
      {
        probeReceiptInbox: async () => ({
          state: 'unreachable',
          detail: 'simulated supervised sidecar outage',
        }),
      },
    );

    try {
      await channel.connect();
      await expect(
        channel.sendMessage(
          'bb:iMessage;-;fixture-chat-1',
          'must not dispatch',
        ),
      ).rejects.toMatchObject({
        code: 'CHANNEL_DELIVERY_REJECTED_BEFORE_DISPATCH',
      });
      await expect(
        channel.sendArtifact('bb:iMessage;-;fixture-chat-1', {
          kind: 'file',
          filename: 'proof.txt',
          mimeType: 'text/plain',
          bytesBase64: Buffer.from('proof').toString('base64'),
        }),
      ).rejects.toMatchObject({
        code: 'CHANNEL_DELIVERY_REJECTED_BEFORE_DISPATCH',
      });
      expect(providerPostCount).toBe(0);
      expect(channel.getControlSnapshot()).toMatchObject({
        sendEnabled: false,
        receiptInboxState: 'unreachable',
      });
    } finally {
      await channel.disconnect();
      await apiStub.close();
    }
  });

  it('keeps sends fail-closed when the exact main-process receipt consumer is not polling', async () => {
    let providerPostCount = 0;
    const apiStub = await startBlueBubblesApiStub(async (req, _body, res) => {
      if ((req.method || 'GET').toUpperCase() === 'POST') {
        providerPostCount += 1;
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: [] }));
    });
    const probeReceiptInbox = vi.fn(async () => ({
      state: 'reachable' as const,
      detail: 'sidecar alone is healthy',
    }));
    const channel = new BlueBubblesChannel(
      buildConfig({
        baseUrl: apiStub.baseUrl,
        receiptInboxSupervisionRequired: true,
      }),
      {
        onMessage: vi.fn(),
        onChatMetadata: vi.fn(),
        registeredGroups: () => ({}),
        onHealthUpdate: vi.fn(),
        isBlueBubblesReceiptConsumerReady: () => false,
      },
      { probeReceiptInbox },
    );

    try {
      await channel.connect();
      await expect(
        channel.sendMessage(
          'bb:iMessage;-;fixture-chat-1',
          'must not dispatch',
        ),
      ).rejects.toMatchObject({
        code: 'CHANNEL_DELIVERY_REJECTED_BEFORE_DISPATCH',
      });
      expect(providerPostCount).toBe(0);
      expect(probeReceiptInbox).not.toHaveBeenCalled();
      expect(channel.getControlSnapshot()).toMatchObject({
        sendEnabled: false,
        receiptInboxState: 'unreachable',
      });
      expect(channel.getControlSnapshot().receiptInboxDetail).toContain(
        'main-process durable receipt consumer is not running',
      );
    } finally {
      await channel.disconnect();
      await apiStub.close();
    }
  });

  it('does not hydrate or substitute a target after an existing-chat dispatch', async () => {
    vi.stubEnv(
      'BLUEBUBBLES_CANONICAL_SELF_THREAD_JID',
      'bb:iMessage;-;+13125550101',
    );
    vi.stubEnv(
      'BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS',
      'bb:iMessage;-;+13125550101',
    );
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
                chatIdentifier: '+13125550101',
                lastAddressedHandle: 'owner@example.com',
                handle: {
                  address: '+13125550101',
                  displayName: 'Jeff',
                  service: 'iMessage',
                },
                chats: [
                  {
                    guid: 'iMessage;-;+13125550101',
                    chatIdentifier: '+13125550101',
                    lastAddressedHandle: 'owner@example.com',
                    service: 'iMessage',
                    isGroup: false,
                    participants: [{ address: '+13125550101' }],
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
      if (parsed.chatGuid === 'iMessage;-;+13125550101') {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Message Send Error' }));
        return;
      }
      if (parsed.chatGuid === 'any;-;owner@example.com') {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Message Send Error' }));
        return;
      }
      if (parsed.chatGuid === 'iMessage;-;owner@example.com') {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({ data: { guid: `server-msg-${requests.length}` } }),
        );
        return;
      }
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          error: `unexpected target ${String(parsed.chatGuid || 'none')}`,
        }),
      );
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
        onChatMetadata: vi.fn(
          async (chatJid, timestamp, name, channelName, isGroup) => {
            storeChatMetadata(chatJid, timestamp, name, channelName, isGroup);
          },
        ),
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
            chatGuid: 'iMessage;-;+13125550101',
            chat: {
              guid: 'iMessage;-;+13125550101',
              displayName: 'Jeff',
              isGroup: false,
              chatIdentifier: '+13125550101',
              participants: [{ address: '+13125550101' }],
            },
            message: {
              guid: 'msg-self-1',
              body: '@Andrea hi',
              senderName: 'Jeff',
              handle: {
                address: '+13125550101',
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
          'bb:iMessage;-;+13125550101',
          'iMessage;-;+13125550101',
        ),
      ).toEqual([
        { kind: 'chat_guid', chatGuid: 'iMessage;-;+13125550101' },
        { kind: 'chat_identifier', chatGuid: 'any;-;+13125550101' },
      ]);

      await expect(
        channel.sendMessage('bb:iMessage;-;+13125550101', 'Hi. I am here.', {
          idempotencyKey: 'message-action:no-target-fallthrough-1',
        }),
      ).rejects.toMatchObject({ code: 'CHANNEL_DELIVERY_UNVERIFIED' });

      expect(historyRequests).toHaveLength(0);
      expect(requests.map((request) => request.chatGuid)).toEqual([
        'iMessage;-;+13125550101',
      ]);
      expect(
        requests.every((request) => request.method === 'apple-script'),
      ).toBe(true);
      expect(requests[0]?.tempGuid).toBe(
        'message-action:no-target-fallthrough-1',
      );
      expect(
        (channel as any)['buildOutboundTargetCandidates'](
          'bb:iMessage;-;+13125550101',
          'iMessage;-;+13125550101',
        ),
      ).toEqual([
        { kind: 'chat_guid', chatGuid: 'iMessage;-;+13125550101' },
        { kind: 'chat_identifier', chatGuid: 'any;-;+13125550101' },
      ]);
      expect(
        healthDetails.every(
          (detail) => !detail.includes('last metadata hydration history'),
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
          detail.includes('attempted target sequence chat_guid'),
        ),
      ).toBe(true);
    } finally {
      await channel.disconnect();
      await apiStub.close();
    }
  });

  it('rejects ordinary group-chat sends before any fallback or provider POST', async () => {
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
      ).rejects.toMatchObject({
        code: 'CHANNEL_DELIVERY_REJECTED_BEFORE_DISPATCH',
      });
      expect(requests).toHaveLength(0);
      expect(historyRequests).toHaveLength(0);
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

  it('passes self-authored contact chatter through for passive data sync', async () => {
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

      expect(response.status).toBe(200);
      expect(onMessage).toHaveBeenCalledWith(
        'bb:iMessage;+;chat-mention',
        expect.objectContaining({
          id: 'bb:msg-self-social',
          content: 'sounds good',
          is_from_me: true,
        }),
      );
      expect(onChatMetadata).toHaveBeenCalled();
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

  it('requires a webhook secret before accepting inbound traffic or enabling outbound sends', async () => {
    const providerPostPaths: string[] = [];
    const apiStub = await startBlueBubblesApiStub(async (req, _body, res) => {
      if ((req.method || 'GET').toUpperCase() === 'POST') {
        providerPostPaths.push(req.url || '');
      }
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
    const onMessage = vi.fn();
    const channel = new BlueBubblesChannel(
      buildConfig({
        baseUrl: apiStub.baseUrl,
        webhookSecret: null,
      }),
      {
        onMessage,
        onChatMetadata: vi.fn(),
        registeredGroups: () => ({}),
        onHealthUpdate: vi.fn(),
      },
    );

    try {
      await channel.connect();
      const forgedWebhook = await fetch(channel.getWebhookUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'new-message',
          data: {
            chatGuid: 'chat-1',
            message: {
              guid: 'forged-owner-message-1',
              body: 'Send the message now',
              isFromMe: true,
              dateCreated: '2026-07-16T12:00:00.000Z',
            },
          },
        }),
      });

      expect(forgedWebhook.status).toBe(401);
      expect(onMessage).not.toHaveBeenCalled();
      expect(channel.getControlSnapshot().sendEnabled).toBe(false);
      expect(channel.getControlSnapshot().webhookRegistrationState).toBe(
        'not_configured',
      );
      await expect(
        channel.sendMessage(
          'bb:iMessage;-;fixture-chat-1',
          'must not dispatch',
        ),
      ).rejects.toMatchObject({
        code: 'CHANNEL_DELIVERY_REJECTED_BEFORE_DISPATCH',
        evidence: {
          outcome: 'rejected',
          stage: 'local_preflight',
        },
      });
      expect(providerPostPaths).toEqual([]);
    } finally {
      await channel.disconnect();
      await apiStub.close();
    }
  });

  it('treats the chat allowlist as inbound eligibility while permitting exact approval-bound direct sends', async () => {
    const providerRequests: Array<{
      path: string;
      body: Record<string, unknown>;
    }> = [];
    const apiStub = await startBlueBubblesApiStub(async (req, body, res) => {
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

      providerRequests.push({
        path: req.url || '',
        body: JSON.parse(body || '{}') as Record<string, unknown>,
      });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      if ((req.url || '').startsWith('/api/v1/chat/new')) {
        res.end(
          JSON.stringify({
            data: {
              guid: 'iMessage;-;+12025550199',
              messages: [{ guid: 'outside-first-contact-receipt' }],
            },
          }),
        );
        return;
      }
      res.end(JSON.stringify({ data: { guid: 'outside-existing-receipt' } }));
    });
    const channel = new BlueBubblesChannel(
      buildConfig({
        baseUrl: apiStub.baseUrl,
        chatScope: 'allowlist',
        allowedChatGuids: ['inbound-self-thread-only'],
        allowedChatGuid: 'inbound-self-thread-only',
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
        channel.sendMessage(
          'bb:iMessage;-;+12025550123',
          'Exact existing direct.',
          {
            ...buildBlueBubblesAuthorizationOptions(),
            suppressSenderLabel: true,
            idempotencyKey: 'message-action:outside-existing-direct',
          },
        ),
      ).resolves.toMatchObject({
        platformMessageId: 'bb:outside-existing-receipt',
      });

      await expect(
        channel.sendMessage(
          'bb:iMessage;-;+12025550199',
          'Exact first contact.',
          {
            ...buildBlueBubblesAuthorizationOptions(),
            suppressSenderLabel: true,
            blueBubblesCreateChatAddress: '+12025550199',
            idempotencyKey: 'message-action:outside-first-contact',
          },
        ),
      ).resolves.toMatchObject({
        platformMessageId: 'bb:outside-first-contact-receipt',
        threadId: 'bb:iMessage;-;+12025550199',
      });

      expect(providerRequests).toHaveLength(2);
      expect(providerRequests[0]).toMatchObject({
        path: expect.stringContaining('/api/v1/message/text'),
        body: {
          chatGuid: 'iMessage;-;+12025550123',
          tempGuid: 'message-action:outside-existing-direct',
        },
      });
      expect(providerRequests[1]).toMatchObject({
        path: expect.stringContaining('/api/v1/chat/new'),
        body: {
          addresses: ['+12025550199'],
          tempGuid: 'message-action:outside-first-contact',
        },
      });

      await expect(
        channel.sendMessage(
          'bb:iMessage;+;family-group',
          'Do not broaden to groups.',
          {
            ...buildBlueBubblesAuthorizationOptions(),
            suppressSenderLabel: true,
            idempotencyKey: 'message-action:outside-group',
          },
        ),
      ).rejects.toMatchObject({
        code: 'CHANNEL_DELIVERY_REJECTED_BEFORE_DISPATCH',
      });
      await expect(
        channel.sendMessage(
          'bb:iMessage;-;+12025550124',
          'Ordinary out-of-scope reply.',
        ),
      ).rejects.toMatchObject({
        code: 'CHANNEL_DELIVERY_REJECTED_BEFORE_DISPATCH',
      });
      expect(providerRequests).toHaveLength(2);
    } finally {
      await channel.disconnect();
      await apiStub.close();
    }
  });

  it('does not let all_synced scope authorize ordinary contact or group sends', async () => {
    const providerRequests: Array<{
      path: string;
      body: Record<string, unknown>;
    }> = [];
    const apiStub = await startBlueBubblesApiStub(async (req, body, res) => {
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
      if ((req.method || 'GET').toUpperCase() === 'POST') {
        providerRequests.push({
          path: req.url || '',
          body: JSON.parse(body || '{}') as Record<string, unknown>,
        });
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: { guid: 'approved-direct-receipt' } }));
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
      providerRequests.length = 0;

      await expect(
        channel.sendMessage(
          'bb:iMessage;-;+12025550123',
          'Ordinary assistant/status text must not reach a contact.',
        ),
      ).rejects.toThrow('immutable owner-authorization fence');
      await expect(
        channel.sendMessage(
          'bb:iMessage;+;family-group',
          'Ordinary assistant/status text must not reach a group.',
        ),
      ).rejects.toThrow('immutable owner-authorization fence');
      expect(providerRequests).toEqual([]);

      await expect(
        channel.sendMessage(
          'bb:iMessage;-;+12025550123',
          'Exact owner-approved direct message.',
          {
            ...buildBlueBubblesAuthorizationOptions(),
            suppressSenderLabel: true,
            idempotencyKey: 'message-action:all-synced-approved-direct',
          },
        ),
      ).resolves.toMatchObject({
        platformMessageId: 'bb:approved-direct-receipt',
      });
      expect(providerRequests).toHaveLength(1);
      expect(providerRequests[0]).toMatchObject({
        path: expect.stringContaining('/api/v1/message/text'),
        body: {
          chatGuid: 'iMessage;-;+12025550123',
          message: 'Exact owner-approved direct message.',
          tempGuid: 'message-action:all-synced-approved-direct',
        },
      });
    } finally {
      await channel.disconnect();
      await apiStub.close();
    }
  });

  it('refuses non-self-thread artifacts under all_synced without a provider POST', async () => {
    const providerPostPaths: string[] = [];
    const apiStub = await startBlueBubblesApiStub(async (req, _body, res) => {
      if ((req.method || 'GET').toUpperCase() === 'POST') {
        providerPostPaths.push(req.url || '');
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      if ((req.url || '').startsWith('/api/v1/server/info')) {
        res.end(JSON.stringify({ data: { private_api: true } }));
        return;
      }
      res.end(JSON.stringify({ data: [] }));
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
    const artifact = {
      kind: 'file' as const,
      filename: 'must-not-send.txt',
      mimeType: 'text/plain',
      bytesBase64: Buffer.from('must not send').toString('base64'),
    };

    try {
      await channel.connect();
      providerPostPaths.length = 0;

      await expect(
        channel.sendArtifact('bb:iMessage;-;+12025550123', artifact),
      ).rejects.toThrow('explicitly configured owner self-thread');
      await expect(
        channel.sendArtifact('bb:iMessage;+;family-group', artifact),
      ).rejects.toThrow('explicitly configured owner self-thread');
      expect(providerPostPaths).toEqual([]);
    } finally {
      await channel.disconnect();
      await apiStub.close();
    }
  });

  it('uses AppleScript even when BlueBubbles advertises Private API, and preserves Unicode', async () => {
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
      const unicodeMessage = 'Hello 👋🏽 — Cafe\u0301 is ready. 🫠';
      const result = await channel.sendMessage(
        'bb:iMessage;-;fixture-chat-1',
        unicodeMessage,
        {
          idempotencyKey: 'message-action:stable-existing-1',
        },
      );

      expect(result.platformMessageId).toBe('bb:server-msg-7');
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toContain('/api/v1/message/text');
      expect(requests[0]?.url).toContain('guid=secret');
      expect(requests[0]?.url).toContain('password=secret');
      expect(requests[0]?.url).toContain('token=secret');
      expect(requests[0]?.body).toMatchObject({
        chatGuid: 'iMessage;-;fixture-chat-1',
        message: `Andrea: ${unicodeMessage}`,
        method: 'apple-script',
        tempGuid: 'message-action:stable-existing-1',
      });
      expect(
        listRecentMessagesForChat('bb:iMessage;-;fixture-chat-1', 1),
      ).toContainEqual(
        expect.objectContaining({
          id: 'bb:server-msg-7',
          content: `Andrea: ${unicodeMessage}`,
          is_from_me: 1,
          is_bot_message: 1,
          provider_idempotency_key: 'message-action:stable-existing-1',
        }),
      );
    } finally {
      await channel.disconnect();
      await apiStub.close();
    }
  });

  it('keeps AppleScript send mode when the server-info probe fails', async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const apiStub = await startBlueBubblesApiStub(async (req, body, res) => {
      if ((req.url || '').startsWith('/api/v1/webhook')) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ data: [] }));
        return;
      }
      if ((req.url || '').startsWith('/api/v1/server/info')) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'server info unavailable' }));
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
      res.end(JSON.stringify({ data: { guid: 'server-msg-probe-fail' } }));
    });

    const healthDetails: string[] = [];
    const channel = new BlueBubblesChannel(
      buildConfig({ baseUrl: apiStub.baseUrl }),
      {
        onMessage: vi.fn(),
        onChatMetadata: vi.fn(),
        registeredGroups: () => ({}),
        onHealthUpdate: (snapshot) => {
          if (snapshot.detail) healthDetails.push(snapshot.detail);
        },
      },
    );

    try {
      await channel.connect();
      const result = await channel.sendMessage(
        'bb:iMessage;-;fixture-chat-1',
        'Probe failed but AppleScript still sends.',
        {
          idempotencyKey: 'message-action:probe-fail-applescript-1',
        },
      );

      expect(result.platformMessageId).toBe('bb:server-msg-probe-fail');
      expect(requests).toHaveLength(1);
      expect(requests[0]?.body).toMatchObject({
        chatGuid: 'iMessage;-;fixture-chat-1',
        method: 'apple-script',
        tempGuid: 'message-action:probe-fail-applescript-1',
      });
      expect(
        healthDetails.some((detail) =>
          detail.includes('send method apple-script'),
        ),
      ).toBe(true);
      expect(
        healthDetails.every(
          (detail) => !detail.includes('send method private-api'),
        ),
      ).toBe(true);
    } finally {
      await channel.disconnect();
      await apiStub.close();
    }
  });

  it('times out an indeterminate text POST as unverified without a second dispatch', async () => {
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
      const realFetch = globalThis.fetch;
      const realSetImmediate = setImmediate;
      let textDispatchCount = 0;
      vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
        if (String(input).includes('/api/v1/message/text')) {
          textDispatchCount += 1;
          return new Promise<Response>((_resolve, reject) => {
            const rejectAsAborted = () => {
              const error = new Error('aborted');
              error.name = 'AbortError';
              reject(error);
            };
            if (init?.signal?.aborted) {
              rejectAsAborted();
              return;
            }
            init?.signal?.addEventListener('abort', rejectAsAborted, {
              once: true,
            });
          });
        }
        return realFetch(input, init);
      });
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

      const outcome = channel
        .sendMessage('bb:iMessage;-;fixture-chat-1', 'one dispatch only', {
          idempotencyKey: 'message-action:timeout-1',
        })
        .catch((error: unknown) => error);
      for (
        let attempt = 0;
        attempt < 20 && textDispatchCount === 0;
        attempt += 1
      ) {
        await new Promise<void>((resolve) => realSetImmediate(resolve));
      }
      expect(textDispatchCount).toBe(1);

      await vi.advanceTimersByTimeAsync(15_001);
      await expect(outcome).resolves.toMatchObject({
        code: 'CHANNEL_DELIVERY_UNVERIFIED',
        evidence: {
          outcome: 'unknown',
          confirmedReceiptIds: [],
          confirmedReceiptCount: 0,
        },
      });
      expect(textDispatchCount).toBe(1);
    } finally {
      await channel.disconnect();
      vi.useRealTimers();
      await apiStub.close();
    }
  });

  it('keeps a response-body timeout unverified after the single durable POST', async () => {
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
      const realFetch = globalThis.fetch;
      const realSetImmediate = setImmediate;
      let textDispatchCount = 0;
      vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
        if (String(input).includes('/api/v1/message/text')) {
          textDispatchCount += 1;
          return Promise.resolve({
            ok: true,
            status: 200,
            text: () => new Promise<string>(() => undefined),
          } as Response);
        }
        return realFetch(input, init);
      });
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

      const outcome = channel
        .sendMessage('bb:iMessage;-;fixture-chat-1', 'body timeout', {
          idempotencyKey: 'message-action:body-timeout-1',
        })
        .catch((error: unknown) => error);
      for (
        let attempt = 0;
        attempt < 20 && textDispatchCount === 0;
        attempt += 1
      ) {
        await new Promise<void>((resolve) => realSetImmediate(resolve));
      }
      expect(textDispatchCount).toBe(1);

      await vi.advanceTimersByTimeAsync(15_001);
      await expect(outcome).resolves.toMatchObject({
        code: 'CHANNEL_DELIVERY_UNVERIFIED',
        evidence: { outcome: 'unknown' },
      });
      expect(textDispatchCount).toBe(1);
    } finally {
      await channel.disconnect();
      vi.useRealTimers();
      await apiStub.close();
    }
  });

  it('treats a duplicate stable tempGuid response as correlated uncertainty', async () => {
    const textDispatches: Array<Record<string, unknown>> = [];
    const apiStub = await startBlueBubblesApiStub(async (req, body, res) => {
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
      textDispatches.push(JSON.parse(body) as Record<string, unknown>);
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          error:
            'Message is already queued to be sent! (Temp GUID: message-action:duplicate-1)',
        }),
      );
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
      await expect(
        channel.sendMessage(
          'bb:iMessage;-;fixture-chat-1',
          'duplicate request identity',
          {
            idempotencyKey: 'message-action:duplicate-1',
          },
        ),
      ).rejects.toMatchObject({
        code: 'CHANNEL_DELIVERY_UNVERIFIED',
        evidence: { outcome: 'unknown' },
      });
      expect(textDispatches).toHaveLength(1);
      expect(textDispatches[0]?.tempGuid).toBe('message-action:duplicate-1');
    } finally {
      await channel.disconnect();
      await apiStub.close();
    }
  });

  it('preserves a receipt returned with an unverified text response', async () => {
    const textDispatches: Array<Record<string, unknown>> = [];
    const apiStub = await startBlueBubblesApiStub(async (req, body, res) => {
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
      textDispatches.push(JSON.parse(body) as Record<string, unknown>);
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: { guid: 'server-maybe-11' } }));
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
      await expect(
        channel.sendMessage(
          'bb:iMessage;-;fixture-chat-1',
          'receipt may have landed',
          {
            idempotencyKey: 'message-action:uncertain-receipt-1',
          },
        ),
      ).rejects.toMatchObject({
        code: 'CHANNEL_DELIVERY_UNVERIFIED',
        evidence: {
          outcome: 'unknown',
          confirmedReceiptIds: ['bb:server-maybe-11'],
          confirmedReceiptCount: 1,
        },
      });
      expect(textDispatches).toHaveLength(1);
      expect(textDispatches[0]?.tempGuid).toBe(
        'message-action:uncertain-receipt-1',
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
      res.end(
        JSON.stringify({ data: { guid: `server-msg-${requests.length}` } }),
      );
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
      await channel.sendMessage(
        'bb:iMessage;-;fixture-chat-1',
        'Andrea: Already labeled.',
      );
      await channel.sendMessage(
        'bb:iMessage;-;fixture-chat-1',
        'First line.\nSecond line.',
      );

      expect(requests).toHaveLength(2);
      expect(requests[0]?.message).toBe('Andrea: Already labeled.');
      expect(requests[1]?.message).toBe('Andrea: First line.\nSecond line.');
      expect(
        listRecentMessagesForChat('bb:iMessage;-;fixture-chat-1', 2),
      ).toContainEqual(
        expect.objectContaining({
          id: 'bb:server-msg-2',
          content: 'Andrea: First line.\nSecond line.',
          is_bot_message: 1,
        }),
      );
      expect(
        listRecentMessagesForChat('bb:iMessage;-;fixture-chat-1', 2),
      ).toContainEqual(
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
      await channel.sendMessage(
        'bb:iMessage;-;+15551234567',
        'Yes, tonight still works for me.',
        {
          ...buildBlueBubblesAuthorizationOptions(),
          suppressSenderLabel: true,
          idempotencyKey: 'message-action:approved-external-1',
        },
      );

      expect(requests[0]?.body).toMatchObject({
        chatGuid: 'iMessage;-;+15551234567',
        message: 'Yes, tonight still works for me.',
        tempGuid: 'message-action:approved-external-1',
      });
      expect(
        listRecentMessagesForChat('bb:iMessage;-;+15551234567', 1),
      ).toContainEqual(
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

  it('accepts a canonically identical first-contact receipt across service and phone formatting', async () => {
    const requests: Array<{
      url: string;
      body: Record<string, unknown>;
    }> = [];
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
      requests.push({
        url: req.url || '',
        body: JSON.parse(body || '{}') as Record<string, unknown>,
      });
      if (!(req.url || '').startsWith('/api/v1/chat/new')) {
        res.statusCode = 500;
        res.end('unexpected endpoint');
        return;
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          data: {
            guid: 'SMS;-;2025550199',
            messages: [{ guid: 'new-chat-message-1' }],
          },
        }),
      );
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
        channel.sendMessage(
          'bb:iMessage;-;+12025550199',
          'Welcome to the neighborhood.',
          {
            suppressSenderLabel: true,
            blueBubblesCreateChatAddress: '+12025550198',
          },
        ),
      ).rejects.toThrow('does not match the approved target');
      expect(requests).toHaveLength(0);

      const result = await channel.sendMessage(
        'bb:iMessage;-;+12025550199',
        'Welcome to the neighborhood.',
        {
          ...buildBlueBubblesAuthorizationOptions(),
          suppressSenderLabel: true,
          blueBubblesCreateChatAddress: '+1 (202) 555-0199',
          idempotencyKey: 'message-action:stable-first-contact-1',
        },
      );

      expect(result).toEqual({
        platformMessageId: 'bb:new-chat-message-1',
        threadId: 'bb:SMS;-;2025550199',
      });
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toContain('/api/v1/chat/new');
      expect(requests[0]?.body).toMatchObject({
        addresses: ['+12025550199'],
        message: 'Welcome to the neighborhood.',
        method: 'apple-script',
        service: 'iMessage',
        tempGuid: 'message-action:stable-first-contact-1',
      });
      expect(
        listRecentMessagesForChat('bb:SMS;-;2025550199', 1),
      ).toContainEqual(
        expect.objectContaining({
          id: 'bb:new-chat-message-1',
          content: 'Welcome to the neighborhood.',
          is_from_me: 1,
          is_bot_message: 0,
        }),
      );
    } finally {
      await channel.disconnect();
      await apiStub.close();
    }
  });

  it.each([
    ['a group chat', 'iMessage;+;provider-group-guid'],
    ['an opaque chat', 'provider-opaque-2025550199'],
    ['a different direct recipient', 'iMessage;-;+13125550199'],
  ])(
    'marks a first-contact receipt for %s as delivery unverified',
    async (_description, returnedChatGuid) => {
      const createChatRequests: Array<Record<string, unknown>> = [];
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
        createChatRequests.push(
          JSON.parse(body || '{}') as Record<string, unknown>,
        );
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            data: {
              guid: returnedChatGuid,
              messages: [{ guid: 'wrong-first-contact-message-1' }],
            },
          }),
        );
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
          channel.sendMessage(
            'bb:iMessage;-;+12025550199',
            'Welcome to the neighborhood.',
            {
              ...buildBlueBubblesAuthorizationOptions(),
              suppressSenderLabel: true,
              blueBubblesCreateChatAddress: '+1 (202) 555-0199',
              idempotencyKey: `message-action:wrong-first-contact-${returnedChatGuid}`,
            },
          ),
        ).rejects.toMatchObject({
          code: 'CHANNEL_DELIVERY_UNVERIFIED',
          evidence: {
            outcome: 'unknown',
            confirmedReceiptIds: ['bb:wrong-first-contact-message-1'],
            confirmedReceiptCount: 1,
          },
        });
        expect(createChatRequests).toHaveLength(1);
        expect(createChatRequests[0]?.addresses).toEqual(['+12025550199']);
        expect(
          listRecentMessagesForChat(`bb:${returnedChatGuid}`, 1),
        ).toHaveLength(0);
      } finally {
        await channel.disconnect();
        await apiStub.close();
      }
    },
  );

  it('marks an uncertain first-contact response unverified and never falls back to an existing-chat send', async () => {
    const sendPaths: string[] = [];
    const apiStub = await startBlueBubblesApiStub(async (req, _body, res) => {
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
      sendPaths.push(req.url || '');
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'chat verification did not finish' }));
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
        channel.sendMessage(
          'bb:iMessage;-;+12025550199',
          'Welcome to the neighborhood.',
          {
            ...buildBlueBubblesAuthorizationOptions(),
            suppressSenderLabel: true,
            blueBubblesCreateChatAddress: '+12025550199',
            idempotencyKey: 'message-action:uncertain-first-contact-1',
          },
        ),
      ).rejects.toMatchObject({ code: 'CHANNEL_DELIVERY_UNVERIFIED' });
      expect(sendPaths).toHaveLength(1);
      expect(sendPaths[0]).toContain('/api/v1/chat/new');
      expect(sendPaths[0]).not.toContain('/api/v1/message/text');
      expect(
        listRecentMessagesForChat('bb:iMessage;-;+12025550199', 1),
      ).toHaveLength(0);
    } finally {
      await channel.disconnect();
      await apiStub.close();
    }
  });

  it('does not retry a durable threaded send after a definite provider rejection', async () => {
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
      if (!(req.url || '').startsWith('/api/v1/message/text')) {
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
      await expect(
        channel.sendMessage('bb:iMessage;-;fixture-chat-1', 'Andrea reply', {
          replyToMessageId: 'bb:msg-2',
          idempotencyKey: 'message-action:threaded-1',
        }),
      ).rejects.toMatchObject({
        code: 'CHANNEL_DELIVERY_REJECTED_BEFORE_DISPATCH',
        evidence: {
          outcome: 'rejected',
          stage: 'provider_pre_effect',
        },
      });

      expect(requests).toHaveLength(1);
      expect(requests[0]?.message).toBe('Andrea: Andrea reply');
      expect(requests[0]?.selectedMessageGuid).toBe('msg-2');
      expect(requests[0]?.tempGuid).toBe('message-action:threaded-1');
    } finally {
      await channel.disconnect();
      await apiStub.close();
    }
  });

  it('falls back without threading for an ordinary reply after a definite rejection', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const apiStub = await startBlueBubblesApiStub(async (req, body, res) => {
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
      res.end(JSON.stringify({ data: { guid: 'server-msg-ordinary-1' } }));
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
      const result = await channel.sendMessage(
        'bb:iMessage;-;fixture-chat-1',
        'ordinary reply',
        {
          replyToMessageId: 'bb:msg-ordinary-1',
        },
      );

      expect(result.platformMessageId).toBe('bb:server-msg-ordinary-1');
      expect(requests).toHaveLength(2);
      expect(requests[0]?.selectedMessageGuid).toBe('msg-ordinary-1');
      expect(requests[1]?.selectedMessageGuid).toBeUndefined();
    } finally {
      await channel.disconnect();
      await apiStub.close();
    }
  });

  it('rechecks the owner pause before a compatibility retry can issue another provider POST', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const apiStub = await startBlueBubblesApiStub(async (req, body, res) => {
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
      if (!(req.url || '').startsWith('/api/v1/message/text')) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ data: [] }));
        return;
      }
      const parsed = JSON.parse(body) as Record<string, unknown>;
      requests.push(parsed);
      setMessagingOutboundPaused({
        paused: true,
        changedByChatJid: 'tg:owner',
        reason: 'owner_pause_between_provider_attempts',
      });
      setMessagingOutboundPaused({
        paused: false,
        changedByChatJid: 'tg:owner',
        reason: 'owner_resume_between_provider_attempts',
      });
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'reply target rejected' }));
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
      await expect(
        channel.sendMessage('bb:iMessage;-;fixture-chat-1', 'ordinary reply', {
          replyToMessageId: 'bb:msg-pause-between-attempts',
        }),
      ).rejects.toThrow('pause generation');
      expect(requests).toHaveLength(1);
      expect(requests[0]?.selectedMessageGuid).toBe(
        'msg-pause-between-attempts',
      );
    } finally {
      await channel.disconnect();
      await apiStub.close();
    }
  });

  it('fails cleanly when outbound sends are disabled and fences a missing receipt as unknown', async () => {
    const textDispatches: string[] = [];
    const noReceiptStub = await startBlueBubblesApiStub(
      async (req, _body, res) => {
        if ((req.url || '').startsWith('/api/v1/message/text')) {
          textDispatches.push(req.url || '');
        }
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true }));
      },
    );

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
      await expect(
        disabled.sendMessage('bb:iMessage;-;fixture-chat-1', 'hello'),
      ).rejects.toMatchObject({
        code: 'CHANNEL_DELIVERY_REJECTED_BEFORE_DISPATCH',
        evidence: {
          outcome: 'rejected',
          stage: 'local_preflight',
        },
      });
      expect(textDispatches).toHaveLength(0);
      await expect(
        missingReceipt.sendMessage('bb:iMessage;-;fixture-chat-1', 'hello'),
      ).rejects.toMatchObject({
        code: 'CHANNEL_DELIVERY_UNVERIFIED',
        evidence: {
          outcome: 'unknown',
          confirmedReceiptIds: [],
          confirmedReceiptCount: 0,
        },
      });
      expect(textDispatches).toHaveLength(1);
    } finally {
      await disabled.disconnect();
      await missingReceipt.disconnect();
      await noReceiptStub.close();
    }
  });

  it('reports healthy inbound-only mode when outbound reply-back is disabled', () => {
    const snapshot = buildBlueBubblesHealthSnapshot(
      buildConfig({ sendEnabled: false }),
    );

    expect(snapshot.configured).toBe(true);
    expect(snapshot.state).toBe('ready');
    expect(snapshot.operatingMode).toBe('inbound_only');
    expect(snapshot.capabilities).toEqual({
      inboundAvailable: true,
      outboundAvailable: false,
    });
    expect(snapshot.alertDisposition).toBe('none');
    expect(snapshot.faultCode).toBeNull();
    expect(snapshot.detail).toContain(
      'outbound reply-back is intentionally disabled',
    );
  });

  it('accepts all-synced inbound chats but rejects ordinary outbound group sends', async () => {
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
      res.end(
        JSON.stringify({ data: { guid: `server-msg-${requests.length}` } }),
      );
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
        onChatMetadata: vi.fn(
          async (chatJid, timestamp, name, channelName, isGroup) => {
            storeChatMetadata(chatJid, timestamp, name, channelName, isGroup);
          },
        ),
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
              participants: [
                { address: '+15551234567' },
                { address: '+15557654321' },
              ],
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
      await expect(
        channel.sendMessage('bb:iMessage;+;chat-2', 'Hi. I am here.'),
      ).rejects.toMatchObject({
        code: 'CHANNEL_DELIVERY_REJECTED_BEFORE_DISPATCH',
      });

      expect(inbound.status).toBe(200);
      expect(onMessage).toHaveBeenCalledWith(
        'bb:iMessage;+;chat-2',
        expect.objectContaining({
          id: 'bb:msg-chat-2',
          content: '@Andrea hi',
        }),
      );
      expect(requests).toEqual([]);
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

  it('does not mark stale server history as a fresh missed inbound', async () => {
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
                guid: 'stale-missed-msg-1',
                text: 'This is older history',
                senderName: 'Jeff',
                handle: { address: '+14695550123', displayName: 'Jeff' },
                dateCreated: '2026-04-12T19:40:00.000Z',
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
      expect(latestHealth?.detail).toContain('detection healthy');
      expect(latestHealth?.detail).not.toContain(
        'detection suspected_missed_inbound',
      );

      const monitorState = readBlueBubblesMonitorState();
      expect(monitorState.recentEvidence).toEqual([]);
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
      expect(
        monitorState.candidateProbeResults['http://127.0.0.1:9'],
      ).toContain('unreachable');
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

    const onHealthUpdate = vi.fn();
    const channel = new BlueBubblesChannel(config, {
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
      onHealthUpdate,
    });

    try {
      await channel.connect();

      const monitorState = readBlueBubblesMonitorState();
      expect(monitorState.detectionState).toBe('healthy');
      const latestHealth = onHealthUpdate.mock.calls.at(-1)?.[0];
      expect(latestHealth?.detail).toContain(
        `active endpoint ${apiStub.baseUrl}`,
      );
    } finally {
      await channel.disconnect();
      await apiStub.close();
    }
  });

  it('republishes recovered health after a completed shadow monitor pass', async () => {
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
      const staleState = readBlueBubblesMonitorState();
      (channel as any).monitorState = {
        ...staleState,
        detectionState: 'transport_unreachable',
        detectionDetail:
          'Andrea could not reach the BlueBubbles server during startup.',
        detectionNextAction: 'Retry after startup.',
      };
      onHealthUpdate.mockClear();

      await (channel as any).runShadowMonitorOnce();

      expect(onHealthUpdate).toHaveBeenCalledTimes(1);
      const recoveredHealth = onHealthUpdate.mock.calls[0]?.[0];
      expect(recoveredHealth?.detail).toContain('detection healthy');
      expect(recoveredHealth?.detail).not.toContain(
        'detection transport_unreachable',
      );
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
    const healthyStub = await startBlueBubblesApiStub(
      async (req, body, res) => {
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
      },
    );

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

      const result = await channel.sendMessage(
        'bb:iMessage;-;fixture-chat-1',
        'Hello after failover.',
      );
      const monitorState = readBlueBubblesMonitorState();

      expect(result.platformMessageId).toBe('bb:healthy-after-failover');
      expect(monitorState.activeBaseUrl).toBe(healthyStub.baseUrl);
      expect(failoverRequests).toHaveLength(1);
      expect(failoverRequests[0]).toMatchObject({
        chatGuid: 'iMessage;-;fixture-chat-1',
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
        detail: expect.stringContaining(
          'could not reach the BlueBubbles server',
        ),
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

  it('passes owner-authored contact text to the data-only ingress policy without triggering fallback', async () => {
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

    const onMessage = vi.fn();
    const channel = new BlueBubblesChannel(
      buildConfig({
        baseUrl: apiStub.baseUrl,
        chatScope: 'all_synced',
        allowedChatGuids: [],
        allowedChatGuid: null,
      }),
      {
        onMessage,
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

      expect(response.status).toBe(200);
      expect(onMessage).toHaveBeenCalledWith(
        'bb:iMessage;-;+14695550123',
        expect.objectContaining({
          id: 'bb:ignored-self-msg-1',
          content: 'just checking in',
          is_from_me: true,
        }),
      );
      expect(readBlueBubblesMonitorState().crossSurfaceFallbackState).toBe(
        'idle',
      );
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
            chatGuid: 'iMessage;-;+12025550101',
            chat: {
              guid: 'iMessage;-;+12025550101',
              displayName: 'Jeff',
              participants: [{ address: '+12025550101' }],
              isGroup: false,
            },
            message: {
              guid: 'self-thread-msg-1',
              body: 'what do i still need to buy',
              senderName: 'Jeff',
              isFromMe: true,
              handle: { address: '+12025550101', displayName: 'Jeff' },
              dateCreated: '2026-04-12T20:08:00.000Z',
            },
          },
        }),
      });

      expect(response.status).toBe(200);
      expect(onMessage).toHaveBeenCalledTimes(1);
      expect(onMessage).toHaveBeenCalledWith(
        'bb:iMessage;-;+12025550101',
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
      if (
        (req.url || '').includes(
          '/api/v1/chat/iMessage%3B-%3B%2B12025550101/message',
        )
      ) {
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
                    guid: 'iMessage;-;+12025550101',
                    displayName: 'Jeff',
                    participants: [{ address: '+12025550101' }],
                    isGroup: false,
                  },
                ],
                handle: { address: '+12025550101', displayName: 'Jeff' },
              },
            ],
          }),
        );
        return;
      }
      if (
        (req.url || '').includes(
          '/api/v1/chat/iMessage%3B-%3B%2B12025550104/message',
        )
      ) {
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
                    guid: 'iMessage;-;+12025550104',
                    displayName: 'Friend',
                    participants: [{ address: '+12025550104' }],
                    isGroup: false,
                  },
                ],
                handle: { address: '+12025550104', displayName: 'Friend' },
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
        'bb:iMessage;-;+12025550104',
        '2026-04-12T20:09:40.000Z',
        'Friend',
        'bluebubbles',
        false,
      );

      await channel.connect();

      const monitorState = readBlueBubblesMonitorState();
      expect(monitorState.shadowPollLastError).toBeNull();
      expect(monitorState.shadowPollMostRecentChat).toBe(
        'bb:iMessage;-;+12025550104',
      );
      expect(monitorState.mostRecentServerSeenChatJid).toBe(
        'bb:iMessage;-;+12025550104',
      );
      expect(monitorState.detectionState).toBe('healthy');
    } finally {
      await channel.disconnect();
      await apiStub.close();
    }
  });

  it('rehydrates persisted outbound diagnostics without promoting an unconfigured thread to control', async () => {
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
      if (
        (req.url || '').includes(
          '/api/v1/chat/iMessage%3B-%3B%2B12025550101/message',
        )
      ) {
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
      lastInboundChatJid: 'bb:iMessage;-;+12025550101',
      lastInboundWasSelfAuthored: true,
      lastOutboundObservedAt: '2026-04-12T20:05:00.000Z',
      lastOutboundObservedChatJid: 'bb:iMessage;-;+12025550101',
      lastOutboundTargetKind: 'chat_guid',
      lastOutboundTargetValue: 'iMessage;-;+12025550101',
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
      expect(latestDetail).toContain('reply gate mention_required');
      expect(latestDetail).toContain('conversation mode data-only');
      expect(latestDetail).toContain(
        'last outbound 2026-04-12T20:05:00.000Z (bb:iMessage;-;+12025550101)',
      );
      expect(latestDetail).toContain('last outbound target kind chat_guid');
      expect(latestDetail).toContain(
        'last outbound target value iMessage;-;+12025550101',
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
                tempGuid: 'message-action:history-prime-1',
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

    storeChatMetadata(
      'bb:iMessage;+;chat-2',
      '2026-04-07T20:00:00.000Z',
      'Candace',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'bb:hist-2',
      chat_jid: 'bb:iMessage;+;chat-2',
      sender: 'bb:+15551234567',
      sender_name: 'Candace',
      content: 'Can you send me the address when you get a chance?',
      timestamp: '2026-04-07T20:00:00.000Z',
      is_from_me: false,
    });

    try {
      const primed = await primeBlueBubblesChatHistory(
        buildConfig({ baseUrl: apiStub.baseUrl }),
        'bb:iMessage;+;chat-2',
        8,
      );

      expect(primed).toEqual({ storedCount: 1, totalCount: 2 });
      expect(
        getActionableMessagesSince('bb:iMessage;+;chat-2', '', 'Andrea').map(
          (message) => message.id,
        ),
      ).toContain('bb:hist-2');
      expect(listRecentMessagesForChat('bb:iMessage;+;chat-2', 4)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'bb:hist-2',
            content: 'Can you send me the address when you get a chance?',
          }),
          expect.objectContaining({
            id: 'bb:hist-3',
            content: 'I can send it now.',
            provider_idempotency_key: 'message-action:history-prime-1',
          }),
        ]),
      );
    } finally {
      await apiStub.close();
    }
  });

  it('hydrates bounded recent history across synced chats on explicit review', async () => {
    const apiStub = await startBlueBubblesApiStub(async (req, _body, res) => {
      if ((req.url || '').startsWith('/api/v1/server/info')) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ data: { private_api: true } }));
        return;
      }
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
      if ((req.url || '').startsWith('/api/v1/message')) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            data: [
              {
                guid: 'recent-across-1',
                text: 'Can you confirm dinner?',
                senderName: 'Candace',
                handle: { address: '+15551234567', displayName: 'Candace' },
                dateCreated: '2026-07-11T18:00:00.000Z',
                isFromMe: false,
                chats: [
                  {
                    guid: 'iMessage;-;+15551234567',
                    displayName: 'Candace',
                    isGroup: false,
                    participants: [{ address: '+15551234567' }],
                  },
                ],
              },
              {
                guid: 'recent-across-2',
                text: 'Practice moved to seven.',
                senderName: 'Rad Dad',
                handle: { address: '+15557654321', displayName: 'Rad Dad' },
                dateCreated: '2026-07-11T18:05:00.000Z',
                isFromMe: false,
                chats: [
                  {
                    guid: 'iMessage;+;rad-dad',
                    displayName: 'Rad Dad',
                    isGroup: true,
                    participants: [{ address: '+15557654321' }],
                  },
                ],
              },
              {
                guid: 'recent-across-outbound',
                tempGuid: 'message-action:startup-prime-1',
                text: 'Provider-confirmed outbound text.',
                senderName: 'You',
                handle: { address: '+15550009999', displayName: 'You' },
                dateCreated: '2026-07-11T18:06:00.000Z',
                isFromMe: true,
                chats: [
                  {
                    guid: 'iMessage;-;+15550009999',
                    displayName: 'Recovery Target',
                    isGroup: false,
                    participants: [{ address: '+15550009999' }],
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
        chatScope: 'allowlist',
        allowedChatGuids: ['iMessage;-;+15551234567', 'iMessage;+;rad-dad'],
        allowedChatGuid: 'iMessage;-;+15551234567',
      }),
      {
        onMessage: vi.fn(),
        onChatMetadata: vi.fn(),
        registeredGroups: () => ({}),
        onHealthUpdate: vi.fn(),
      },
    );

    // Model a prior local observation written before correlation metadata was
    // available. Startup priming must enrich it instead of skipping it.
    storeChatMetadata(
      'bb:iMessage;-;+15550009999',
      '2026-07-11T18:06:00.000Z',
      'Recovery Target',
      'bluebubbles',
      false,
    );
    storeMessageDirect({
      id: 'bb:recent-across-outbound',
      chat_jid: 'bb:iMessage;-;+15550009999',
      sender: 'Me',
      sender_name: 'You',
      content: 'Provider-confirmed outbound text.',
      timestamp: '2026-07-11T18:06:00.000Z',
      is_from_me: true,
      is_bot_message: false,
    });

    try {
      await channel.connect();
      const first = await channel.primeRecentHistory({ limit: 50 });
      const repeated = await channel.primeRecentHistory({ limit: 50 });

      expect(first).toEqual({ storedCount: 2, totalCount: 3 });
      expect(repeated).toEqual({ storedCount: 0, totalCount: 3 });
      expect(
        listRecentMessagesForChat('bb:iMessage;-;+15551234567', 4),
      ).toContainEqual(
        expect.objectContaining({
          id: 'bb:recent-across-1',
          content: 'Can you confirm dinner?',
        }),
      );
      expect(
        listRecentMessagesForChat('bb:iMessage;+;rad-dad', 4),
      ).toContainEqual(
        expect.objectContaining({
          id: 'bb:recent-across-2',
          content: 'Practice moved to seven.',
        }),
      );
      expect(
        listRecentMessagesForChat('bb:iMessage;-;+15550009999', 4),
      ).toContainEqual(
        expect.objectContaining({
          id: 'bb:recent-across-outbound',
          provider_idempotency_key: 'message-action:startup-prime-1',
        }),
      );
    } finally {
      await channel.disconnect();
      await apiStub.close();
    }
  });

  it('targets one exact known quiet thread without depending on the global newest slice', async () => {
    let targetedRequests = 0;
    let globalHistoryRequests = 0;
    const apiStub = await startBlueBubblesApiStub(async (req, _body, res) => {
      if ((req.url || '').startsWith('/api/v1/server/info')) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ data: { private_api: true } }));
        return;
      }
      if ((req.url || '').startsWith('/api/v1/webhook')) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ data: [] }));
        return;
      }
      if ((req.url || '').startsWith('/api/v1/chat/')) {
        targetedRequests += 1;
        const requestUrl = new URL(req.url || '/', apiStub.baseUrl);
        expect(requestUrl.searchParams.get('limit')).toBe('400');
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            data: [
              {
                guid: 'quiet-thread-latest',
                text: 'The quiet-thread update is ready.',
                senderName: 'Avery Example',
                handle: {
                  address: '+12025550123',
                  displayName: 'Avery Example',
                },
                dateCreated: '2026-07-16T20:15:00.000Z',
                isFromMe: false,
                chats: [
                  {
                    guid: 'iMessage;-;+12025550123',
                    displayName: 'Avery Example',
                    isGroup: false,
                    participants: [{ address: '+12025550123' }],
                  },
                ],
              },
            ],
          }),
        );
        return;
      }
      if ((req.url || '').startsWith('/api/v1/message')) {
        globalHistoryRequests += 1;
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ data: [] }));
        return;
      }
      res.statusCode = 404;
      res.end('not found');
    });
    storeChatMetadata(
      'bb:iMessage;-;+12025550123',
      '2026-06-01T12:00:00.000Z',
      'Avery Example',
      'bluebubbles',
      false,
    );
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
      globalHistoryRequests = 0;
      const hydrated = await channel.primeChatHistory(
        'bb:iMessage;-;+12025550123',
        { limit: 900 },
      );

      expect(hydrated).toEqual({
        chatJid: 'bb:iMessage;-;+12025550123',
        storedCount: 1,
        totalCount: 1,
      });
      expect(targetedRequests).toBe(1);
      expect(globalHistoryRequests).toBe(0);
      expect(
        listRecentMessagesForChat('bb:iMessage;-;+12025550123', 1),
      ).toContainEqual(
        expect.objectContaining({
          id: 'bb:quiet-thread-latest',
          content: 'The quiet-thread update is ready.',
        }),
      );
      await expect(
        channel.primeChatHistory('bb:iMessage;-;+12025550999', { limit: 10 }),
      ).rejects.toThrow(/already-known exact chat/i);
      storeChatMetadata(
        'bb:iMessage;-;fixture-chat-1',
        '2026-07-16T20:20:00.000Z',
        'Canonical self-thread fixture',
        'bluebubbles',
        false,
      );
      await expect(
        channel.primeChatHistory('bb:iMessage;-;fixture-chat-1', { limit: 10 }),
      ).rejects.toThrow(/canonical self-thread/i);
      expect(targetedRequests).toBe(1);
    } finally {
      await channel.disconnect();
      await apiStub.close();
    }
  });

  it('aborts a hanging per-chat fallback during startup history recovery', async () => {
    let exerciseHangingFallback = false;
    const apiStub = await startBlueBubblesApiStub(async (req, _body, res) => {
      if ((req.url || '').startsWith('/api/v1/server/info')) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ data: { private_api: true } }));
        return;
      }
      if ((req.url || '').startsWith('/api/v1/message')) {
        if (exerciseHangingFallback) {
          res.statusCode = 404;
          res.end('global history unavailable');
        } else {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ data: [] }));
        }
        return;
      }
      if ((req.url || '').startsWith('/api/v1/chat/')) {
        // Intentionally leave the response open. The bounded fetch must abort.
        return;
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: [] }));
    });
    storeChatMetadata(
      'bb:iMessage;-;+15551234567',
      '2026-07-16T12:00:00.000Z',
      'Hanging fallback fixture',
      'bluebubbles',
      false,
    );
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
      { historyFetchTimeoutMs: 100 },
    );

    try {
      await channel.connect();
      exerciseHangingFallback = true;
      await expect(
        channel.primeRecentHistory({
          limit: 20,
          recoverUnacceptedClaims: true,
        }),
      ).rejects.toThrow(/timed out after 100 ms/i);
    } finally {
      await channel.disconnect();
      await apiStub.close();
    }
  });

  it('primes media-only BlueBubbles history and hydrates cached attachments', async () => {
    let attachmentDownloads = 0;
    const apiStub = await startBlueBubblesApiStub(async (req, _body, res) => {
      if ((req.url || '').startsWith('/api/v1/chat/')) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            data: [
              {
                guid: 'hist-media-1',
                senderName: 'Candace',
                handle: { address: '+15551234567', displayName: 'Candace' },
                dateCreated: '2026-04-07T20:00:00.000Z',
                isFromMe: false,
                attachments: [
                  {
                    guid: 'attach-hist-1',
                    transferName: 'photo.jpg',
                    mimeType: 'image/jpeg',
                    totalBytes: 4,
                  },
                ],
                chats: [
                  {
                    guid: 'iMessage;+;chat-media',
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
      if ((req.url || '').startsWith('/api/v1/attachment/attach-hist-1')) {
        attachmentDownloads += 1;
        res.statusCode = 200;
        res.setHeader('Content-Type', 'image/jpeg');
        res.end(Buffer.from([1, 2, 3, 4]));
        return;
      }
      res.statusCode = 404;
      res.end('not found');
    });

    try {
      const primed = await primeBlueBubblesChatHistory(
        buildConfig({ baseUrl: apiStub.baseUrl }),
        'bb:iMessage;+;chat-media',
        8,
      );
      const [message] = listRecentMessagesForChat(
        'bb:iMessage;+;chat-media',
        4,
      );
      const repeated = await primeBlueBubblesChatHistory(
        buildConfig({ baseUrl: apiStub.baseUrl }),
        'bb:iMessage;+;chat-media',
        8,
      );

      expect(primed).toEqual({ storedCount: 1, totalCount: 1 });
      expect(repeated).toEqual({ storedCount: 0, totalCount: 1 });
      expect(attachmentDownloads).toBe(1);
      expect(message).toMatchObject({
        id: 'bb:hist-media-1',
        content: '[image]',
      });
      expect(message?.attachments?.[0]).toMatchObject({
        kind: 'image',
        filename: 'photo.jpg',
        fetchStatus: 'cached',
        sizeBytes: 4,
      });
      expect(message?.attachments?.[0]?.localPath).toContain('media-cache');
    } finally {
      await apiStub.close();
    }
  });
});
