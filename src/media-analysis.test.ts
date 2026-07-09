import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _initTestDatabase, storeChatMetadata, storeMessage } from './db.js';
import { analyzeMessageMedia } from './media-analysis.js';

const originalApiKey = process.env.OPENAI_API_KEY;
const originalBaseUrl = process.env.OPENAI_BASE_URL;
const originalModel = process.env.OPENAI_MODEL_STANDARD;

describe('media analysis', () => {
  let tempDir = '';

  beforeEach(() => {
    _initTestDatabase();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'andrea-media-analysis-'));
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.OPENAI_BASE_URL = 'https://example.test/v1';
    process.env.OPENAI_MODEL_STANDARD = 'gpt-vision-test';
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    process.env.OPENAI_API_KEY = originalApiKey;
    process.env.OPENAI_BASE_URL = originalBaseUrl;
    process.env.OPENAI_MODEL_STANDARD = originalModel;
    vi.restoreAllMocks();
  });

  it('sends cached image bytes as an OpenAI vision input', async () => {
    const imagePath = path.join(tempDir, 'photo.jpg');
    fs.writeFileSync(imagePath, Buffer.from([1, 2, 3, 4]));
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
});
