import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getMediaProviderStatus, runImageGeneration } from './media-generation.js';
import * as openAiProvider from './openai-provider.js';

const originalFetch = globalThis.fetch;
const originalApiKey = process.env.OPENAI_API_KEY;
const originalBaseUrl = process.env.OPENAI_BASE_URL;
const originalImageModel = process.env.OPENAI_IMAGE_MODEL;

describe('media generation', () => {
  beforeEach(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_IMAGE_MODEL;
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env.OPENAI_API_KEY = originalApiKey;
    process.env.OPENAI_BASE_URL = originalBaseUrl;
    process.env.OPENAI_IMAGE_MODEL = originalImageModel;
    globalThis.fetch = originalFetch;
  });

  it('reports the exact config blocker when OpenAI image generation is not configured', async () => {
    vi.spyOn(openAiProvider, 'getOpenAiProviderStatus').mockReturnValue({
      configured: false,
      missing: ['OPENAI_API_KEY'],
      baseUrl: 'https://api.openai.com/v1',
      researchModel: 'gpt-5.4',
      imageModel: 'gpt-image-1',
    });
    vi.spyOn(openAiProvider, 'resolveOpenAiProviderConfig').mockReturnValue(null);

    const status = getMediaProviderStatus();
    const result = await runImageGeneration({
      prompt: 'a watercolor lake at sunrise',
      channel: 'telegram',
    });

    expect(status.configured).toBe(false);
    expect(status.missing).toContain('OPENAI_API_KEY');
    expect(result.replyText).toContain("I can't make that image right now");
    expect(result.replyText).toContain('tighten the prompt');
    expect(result.blocker).toContain('OPENAI_API_KEY');
    expect(result.artifact).toBeUndefined();
  });

  it('keeps Alexa image requests at the handoff layer', async () => {
    const result = await runImageGeneration({
      prompt: 'a watercolor lake at sunrise',
      channel: 'alexa',
    });

    expect(result.replyText).toContain('Telegram');
    expect(result.routeExplanation).toContain('voice-safe');
  });

  it('returns a Telegram-deliverable image artifact when the provider responds', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.OPENAI_BASE_URL = 'https://example.test/v1';
    process.env.OPENAI_IMAGE_MODEL = 'gpt-image-test';
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          data: [{ b64_json: Buffer.from('png-bytes').toString('base64') }],
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'x-request-id': 'req_image_test',
          },
        },
      );
    }) as typeof fetch;

    const result = await runImageGeneration({
      prompt: 'a watercolor lake at sunrise',
      channel: 'telegram',
    });

    expect(globalThis.fetch).toHaveBeenCalled();
    expect(result.providerUsed).toBe('openai_images');
    expect(result.artifact?.filename).toBe('andrea-generated-image.png');
    expect(result.debugPath).toContain('request_id:req_image_test');
  });

  it('surfaces a quota or billing blocker honestly when the provider rejects the image request', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.OPENAI_BASE_URL = 'https://example.test/v1';
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          error: {
            message: 'Billing hard limit has been reached.',
            type: 'billing_limit_user_error',
            code: 'billing_hard_limit_reached',
          },
        }),
        {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
            'x-request-id': 'req_image_limit',
          },
        },
      );
    }) as typeof fetch;

    const result = await runImageGeneration({
      prompt: 'a watercolor lake at sunrise',
      channel: 'telegram',
    });

    expect(result.replyText).toContain("I can't make that image right now");
    expect(result.replyText).toContain('help plan the shot');
    expect(result.blocker?.toLowerCase()).toMatch(/quota|billing/);
    expect(result.debugPath).toContain('request_id:req_image_limit');
    expect(result.artifact).toBeUndefined();
  });
});
