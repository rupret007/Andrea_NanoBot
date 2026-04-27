import { describe, expect, it } from 'vitest';

import {
  classifyTelegramTransportFailure,
  normalizeTelegramWebhookInfo,
} from './telegram-transport.js';

describe('normalizeTelegramWebhookInfo', () => {
  it('treats a missing URL as no active webhook', () => {
    expect(normalizeTelegramWebhookInfo({})).toEqual({
      present: false,
      url: null,
    });
  });

  it('captures an active webhook URL', () => {
    expect(
      normalizeTelegramWebhookInfo({
        url: 'https://example.com/telegram-webhook',
      }),
    ).toEqual({
      present: true,
      url: 'https://example.com/telegram-webhook',
    });
  });
});

describe('classifyTelegramTransportFailure', () => {
  it('classifies the first setWebhook conflict as a degraded external conflict', () => {
    const classification = classifyTelegramTransportFailure({
      error:
        "Call to 'getUpdates' failed! (409: Conflict: terminated by setWebhook request)",
      consecutiveExternalConflicts: 0,
    });

    expect(classification).toEqual(
      expect.objectContaining({
        errorClass: 'setwebhook_conflict',
        status: 'degraded',
        tokenRotationRequired: false,
      }),
    );
  });

  it('escalates repeated conflicts to token rotation required', () => {
    const classification = classifyTelegramTransportFailure({
      error:
        "Call to 'getUpdates' failed! (409: Conflict: terminated by other getUpdates request)",
      consecutiveExternalConflicts: 1,
    });

    expect(classification).toEqual(
      expect.objectContaining({
        errorClass: 'token_rotation_required',
        status: 'blocked',
        externalConsumerSuspected: true,
        tokenRotationRequired: true,
      }),
    );
  });

  it('treats Telegram 401 Unauthorized as a token/config blocker instead of a restartable local failure', () => {
    const classification = classifyTelegramTransportFailure({
      error: "Call to 'getMe' failed! (401: Unauthorized)",
      consecutiveExternalConflicts: 0,
    });

    expect(classification).toEqual(
      expect.objectContaining({
        errorClass: 'token_rotation_required',
        status: 'blocked',
        externalConsumerSuspected: false,
        tokenRotationRequired: true,
      }),
    );
    expect(classification.detail).toContain('TELEGRAM_BOT_TOKEN');
  });

  it('treats an active webhook after cleanup as an external blocker', () => {
    const classification = classifyTelegramTransportFailure({
      error: 'Telegram webhook is still active after local cleanup.',
      consecutiveExternalConflicts: 0,
      webhookPresent: true,
      webhookUrl: 'https://example.com/tg',
    });

    expect(classification).toEqual(
      expect.objectContaining({
        errorClass: 'webhook_active',
        status: 'degraded',
        externalConsumerSuspected: true,
      }),
    );
    expect(classification.detail).toContain('https://example.com/tg');
  });

  it('preserves unrelated startup errors as local failures', () => {
    const classification = classifyTelegramTransportFailure({
      error: 'Telegram long polling did not report ready in time.',
    });

    expect(classification).toEqual(
      expect.objectContaining({
        errorClass: 'local_start_failure',
        status: 'degraded',
        externalConsumerSuspected: false,
        tokenRotationRequired: false,
      }),
    );
  });
});
