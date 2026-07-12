import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _initTestDatabase,
  getMessageMediaAttachment,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { analyzeMessageMedia } from './media-analysis.js';
import { cacheInboundMediaBytes } from './media-cache.js';

const originalApiKey = process.env.OPENAI_API_KEY;
const originalBaseUrl = process.env.OPENAI_BASE_URL;
const originalModel = process.env.OPENAI_MODEL_STANDARD;
const originalGeminiEnabled = process.env.GEMINI_ENABLED;
const originalGeminiApiKey = process.env.GEMINI_API_KEY;
const originalGeminiBaseUrl = process.env.GEMINI_OPENAI_BASE_URL;
const originalGeminiModel = process.env.GEMINI_MODEL_FAST;

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

describe('media analysis', () => {
  let tempDir = '';

  beforeEach(() => {
    _initTestDatabase();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'andrea-media-analysis-'));
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.OPENAI_BASE_URL = 'https://example.test/v1';
    process.env.OPENAI_MODEL_STANDARD = 'gpt-vision-test';
    process.env.GEMINI_ENABLED = 'false';
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    restoreEnv('OPENAI_API_KEY', originalApiKey);
    restoreEnv('OPENAI_BASE_URL', originalBaseUrl);
    restoreEnv('OPENAI_MODEL_STANDARD', originalModel);
    restoreEnv('GEMINI_ENABLED', originalGeminiEnabled);
    restoreEnv('GEMINI_API_KEY', originalGeminiApiKey);
    restoreEnv('GEMINI_OPENAI_BASE_URL', originalGeminiBaseUrl);
    restoreEnv('GEMINI_MODEL_FAST', originalGeminiModel);
    vi.restoreAllMocks();
  });

  it('sends cached image bytes as an OpenAI vision input', async () => {
    const imagePath = cacheInboundMediaBytes({
      bytes: Buffer.from([1, 2, 3, 4]),
      filename: `photo-${path.basename(tempDir)}.jpg`,
      mimeType: 'image/jpeg',
    }).localPath;
    storeChatMetadata('bb:chat-1', '2026-07-08T12:00:00.000Z', 'Candace');
    storeMessage({
      id: 'bb:msg-1',
      chat_jid: 'bb:chat-1',
      sender: 'bb:+15551234567',
      sender_name: 'Candace',
      content: '[image]',
      timestamp: '2026-07-08T12:00:00.000Z',
      is_from_me: false,
      attachments: [
        {
          attachmentId: 'media:test-image',
          chatJid: 'bb:chat-1',
          messageId: 'bb:msg-1',
          sourceChannel: 'bluebubbles',
          kind: 'image',
          mimeType: 'image/jpeg',
          filename: 'photo.jpg',
          sourceId: 'attach-1',
          localPath: imagePath,
          fetchStatus: 'cached',
          analysisStatus: 'not_requested',
        },
      ],
    });

    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body || '{}')) as {
          model?: string;
          input?: Array<{ content?: Array<Record<string, string>> }>;
        };
        expect(body.model).toBe('gpt-vision-test');
        const content = body.input?.[0]?.content || [];
        expect(content.some((item) => item.type === 'input_text')).toBe(true);
        expect(
          content.some(
            (item) =>
              item.type === 'input_image' &&
              item.image_url?.startsWith('data:image/jpeg;base64,'),
          ),
        ).toBe(true);
        return new Response(
          JSON.stringify({ output_text: 'It shows a photo.' }),
          {
            status: 200,
            headers: { 'x-request-id': 'req-media-test' },
          },
        );
      },
    );

    const result = await analyzeMessageMedia({
      chatJid: 'bb:chat-1',
      messageId: 'bb:msg-1',
      prompt: 'What is in this image?',
      requester: 'andrea',
      fetchImpl,
    });

    expect(result.handled).toBe(true);
    expect(result.summaryText).toBe('It shows a photo.');
    expect(result.debugPath).toContain('request_id:req-media-test');
  });

  it('returns a bounded blocker and records failure for an unreadable provider response', async () => {
    const imagePath = cacheInboundMediaBytes({
      bytes: Buffer.from([1, 2, 3, 4]),
      filename: `broken-${path.basename(tempDir)}.jpg`,
      mimeType: 'image/jpeg',
    }).localPath;
    storeChatMetadata('bb:chat-2', '2026-07-08T12:00:00.000Z', 'Candace');
    storeMessage({
      id: 'bb:msg-2',
      chat_jid: 'bb:chat-2',
      sender: 'bb:+15551234567',
      sender_name: 'Candace',
      content: '[image]',
      timestamp: '2026-07-08T12:00:00.000Z',
      is_from_me: false,
      attachments: [
        {
          attachmentId: 'media:bad-provider-response',
          chatJid: 'bb:chat-2',
          messageId: 'bb:msg-2',
          sourceChannel: 'bluebubbles',
          kind: 'image',
          mimeType: 'image/jpeg',
          filename: 'broken.jpg',
          localPath: imagePath,
          fetchStatus: 'cached',
          analysisStatus: 'not_requested',
        },
      ],
    });

    const result = await analyzeMessageMedia({
      attachmentIds: ['media:bad-provider-response'],
      fetchImpl: vi.fn(async () => new Response('not json', { status: 200 })),
    });

    expect(result.handled).toBe(false);
    expect(result.blocker).toContain('unreadable response');
    expect(result.debugPath).toContain(
      'media.analysis:invalid_provider_response',
    );
    expect(
      getMessageMediaAttachment('media:bad-provider-response')?.analysisStatus,
    ).toBe('failed');
  });

  it('falls back to Gemini vision when OpenAI is unavailable', async () => {
    process.env.GEMINI_ENABLED = 'true';
    process.env.GEMINI_API_KEY = 'gemini-test-key';
    process.env.GEMINI_OPENAI_BASE_URL =
      'https://generativelanguage.example/v1beta/openai';
    process.env.GEMINI_MODEL_FAST = 'gemini-vision-test';
    const imagePath = cacheInboundMediaBytes({
      bytes: Buffer.from([7, 7, 7, 7]),
      filename: `fallback-${path.basename(tempDir)}.jpg`,
      mimeType: 'image/jpeg',
    }).localPath;
    storeChatMetadata('tg:vision-fallback', '2026-07-08T12:00:00.000Z');
    storeMessage({
      id: 'tg:vision-fallback-message',
      chat_jid: 'tg:vision-fallback',
      sender: 'owner',
      sender_name: 'Owner',
      content: '[Photo] meal plan',
      timestamp: '2026-07-08T12:00:00.000Z',
      is_from_me: false,
      attachments: [
        {
          attachmentId: 'media:gemini-fallback',
          chatJid: 'tg:vision-fallback',
          messageId: 'tg:vision-fallback-message',
          sourceChannel: 'telegram',
          kind: 'image',
          mimeType: 'image/jpeg',
          filename: 'fallback.jpg',
          localPath: imagePath,
          fetchStatus: 'cached',
          analysisStatus: 'not_requested',
        },
      ],
    });
    const fetchImpl = vi.fn(async (url: string | URL | Request, init) => {
      if (String(url).endsWith('/responses')) {
        return new Response('{"error":"quota"}', { status: 429 });
      }
      const body = JSON.parse(String(init?.body || '{}')) as {
        model?: string;
        messages?: Array<{ content?: Array<Record<string, unknown>> }>;
      };
      expect(body.model).toBe('gemini-vision-test');
      expect(
        body.messages?.[0]?.content?.some(
          (item) =>
            item.type === 'image_url' && typeof item.image_url === 'object',
        ),
      ).toBe(true);
      return new Response(
        JSON.stringify({
          choices: [
            { message: { content: 'Gemini read the meal plan image.' } },
          ],
        }),
        { status: 200, headers: { 'x-goog-request-id': 'gemini-media-1' } },
      );
    });

    const result = await analyzeMessageMedia({
      attachmentIds: ['media:gemini-fallback'],
      prompt: 'Read this meal plan.',
      fetchImpl,
    });

    expect(result.handled).toBe(true);
    expect(result.providerUsed).toBe('gemini_vision');
    expect(result.summaryText).toBe('Gemini read the meal plan image.');
    expect(result.debugPath).toContain('media.analysis:provider=gemini_vision');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('returns a bounded blocker when the provider transport fails', async () => {
    const imagePath = cacheInboundMediaBytes({
      bytes: Buffer.from([1, 2, 3, 4]),
      filename: `transport-${path.basename(tempDir)}.jpg`,
      mimeType: 'image/jpeg',
    }).localPath;
    storeChatMetadata('bb:chat-3', '2026-07-08T12:00:00.000Z', 'Candace');
    storeMessage({
      id: 'bb:msg-3',
      chat_jid: 'bb:chat-3',
      sender: 'bb:+15551234567',
      sender_name: 'Candace',
      content: '[image]',
      timestamp: '2026-07-08T12:00:00.000Z',
      is_from_me: false,
      attachments: [
        {
          attachmentId: 'media:transport-failure',
          chatJid: 'bb:chat-3',
          messageId: 'bb:msg-3',
          sourceChannel: 'bluebubbles',
          kind: 'image',
          mimeType: 'image/jpeg',
          filename: 'transport.jpg',
          localPath: imagePath,
          fetchStatus: 'cached',
          analysisStatus: 'not_requested',
        },
      ],
    });
    const result = await analyzeMessageMedia({
      attachmentIds: ['media:transport-failure'],
      fetchImpl: vi.fn(async () => {
        throw new Error('network unavailable');
      }),
    });

    expect(result.handled).toBe(false);
    expect(result.blocker).toContain('unavailable right now');
    expect(result.debugPath).toContain(
      'media.analysis:provider_transport_failed',
    );
  });
});
