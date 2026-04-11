import type {
  MediaGenerationRequest,
  MediaGenerationResult,
  MediaProviderStatus,
} from './types.js';
import { buildGracefulDegradedReply } from './conversational-core.js';
import {
  describeOpenAiConfigBlocker,
  describeOpenAiProviderFailure,
  getOpenAiProviderStatus,
  resolveOpenAiProviderConfig,
} from './openai-provider.js';
import { logger } from './logger.js';
import { normalizeVoicePrompt } from './voice-ready.js';

function normalizePrompt(value: string): string {
  return normalizeVoicePrompt(value).replace(/\s+/g, ' ').trim();
}

function buildUnavailableResult(
  request: MediaGenerationRequest,
  status: MediaProviderStatus,
  message: string,
  debugPath: string[],
): MediaGenerationResult {
  const replyText = buildGracefulDegradedReply({
    kind: 'image_generation_unavailable',
    channel: request.channel,
    text: request.prompt,
  });
  return {
    handled: true,
    providerStatus: status,
    blocker: message,
    summaryText: replyText,
    replyText,
    routeExplanation:
      request.channel === 'alexa'
        ? 'I kept this voice-safe and stayed at the handoff layer.'
        : 'I stayed on the shared media capability, but the live image provider is not ready here.',
    debugPath,
  };
}

export function getMediaProviderStatus(): MediaProviderStatus {
  const openAi = getOpenAiProviderStatus();
  return {
    provider: 'openai_images',
    configured: openAi.configured,
    missing: openAi.missing,
    baseUrl: openAi.baseUrl,
    imageModel: openAi.imageModel,
  };
}

export async function runImageGeneration(
  request: MediaGenerationRequest,
): Promise<MediaGenerationResult> {
  const prompt = normalizePrompt(request.prompt);
  const status = getMediaProviderStatus();
  if (!prompt) {
    return buildUnavailableResult(
      request,
      status,
      request.channel === 'alexa'
        ? 'Tell me what image you want, and I can hand that off safely.'
        : 'Tell me what image you want me to make first.',
      ['media.image_generate:empty_prompt'],
    );
  }

  if (request.channel === 'alexa') {
    return {
      handled: true,
      providerStatus: status,
      summaryText:
        'I can handle image requests through Telegram, where I can actually send the result back.',
      replyText:
        'I can generate that, but I would send the image through Telegram rather than read it aloud here.',
      routeExplanation:
        'I kept this voice-safe by treating image generation as a request-and-deliver workflow.',
      debugPath: ['media.image_generate:alexa_handoff_only'],
    };
  }

  const config = resolveOpenAiProviderConfig();
  if (!config) {
    return buildUnavailableResult(
      request,
      status,
      `Image generation is unavailable here because ${describeOpenAiConfigBlocker(status.missing)}`,
      [`media.image_generate:blocked:${status.missing.join(',') || 'unknown'}`],
    );
  }

  try {
    const response = await fetch(`${config.baseUrl}/images/generations`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.imageModel,
        prompt,
        size: request.size || '1024x1024',
      }),
    });

    const requestId = response.headers.get('x-request-id') || undefined;
    if (!response.ok) {
      const errorText = await response.text();
      const providerFailure = describeOpenAiProviderFailure(
        response.status,
        errorText,
        'image',
      );
      logger.warn(
        {
          status: response.status,
          requestId,
          body: errorText.slice(0, 400),
        },
        'Image generation request failed',
      );
      return buildUnavailableResult(
        request,
        status,
        `Image generation is unavailable here because ${providerFailure}`,
        [
          `media.image_generate:provider_error:${response.status}`,
          requestId ? `request_id:${requestId}` : 'request_id:missing',
        ],
      );
    }

    const payload = (await response.json()) as {
      data?: Array<{
        b64_json?: string;
      }>;
      created?: number;
    };
    const base64 = payload.data?.[0]?.b64_json?.trim();
    if (!base64) {
      return buildUnavailableResult(
        request,
        status,
        'The image provider responded, but no image bytes came back.',
        [
          'media.image_generate:missing_b64_json',
          requestId ? `request_id:${requestId}` : 'request_id:missing',
        ],
      );
    }

    return {
      handled: true,
      providerStatus: status,
      providerUsed: 'openai_images',
      summaryText: 'Here is a first image pass based on your prompt.',
      replyText:
        'Here is a first image pass. If you want, I can help tighten the prompt and try a sharper variation next.',
      routeExplanation:
        'I used the shared media capability with the live OpenAI image provider because Telegram can actually deliver the resulting image artifact.',
      debugPath: [
        'media.image_generate:provider=openai_images',
        `media.image_generate:model=${config.imageModel}`,
        requestId ? `request_id:${requestId}` : 'request_id:missing',
      ],
      artifact: {
        kind: 'image',
        filename: 'andrea-generated-image.png',
        mimeType: 'image/png',
        bytesBase64: base64,
        altText: prompt,
      },
    };
  } catch (err) {
    logger.warn({ err }, 'Image generation request errored');
    return buildUnavailableResult(
      request,
      status,
      'Image generation is unavailable here because the provider request errored before a result came back.',
      ['media.image_generate:request_exception'],
    );
  }
}
