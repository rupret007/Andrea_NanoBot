import type { TelegramTransportErrorClass } from './host-control.js';

export interface TelegramWebhookSnapshot {
  present: boolean;
  url: string | null;
}

export interface TelegramTransportFailureClassification {
  detail: string;
  errorClass: TelegramTransportErrorClass;
  status: 'degraded' | 'blocked';
  externalConsumerSuspected: boolean;
  tokenRotationRequired: boolean;
}

function normalizeErrorText(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  if (typeof error === 'string' && error.trim()) {
    return error.trim();
  }
  return 'Telegram long polling failed unexpectedly.';
}

export function normalizeTelegramWebhookInfo(
  value: unknown,
): TelegramWebhookSnapshot {
  if (!value || typeof value !== 'object') {
    return { present: false, url: null };
  }
  const rawUrl =
    'url' in (value as Record<string, unknown>)
      ? (value as { url?: unknown }).url
      : '';
  const url = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  return {
    present: url.length > 0,
    url: url || null,
  };
}

function buildSharedTokenDetail(webhookUrl: string | null): string {
  const webhookNote = webhookUrl
    ? ` Telegram still reports an active webhook at ${webhookUrl}.`
    : '';
  return (
    'Telegram long polling is still colliding with another consumer after local cleanup. ' +
    'Rotate the Telegram bot token and retire the competing consumer before trusting Telegram again.' +
    webhookNote
  );
}

export function classifyTelegramTransportFailure(input: {
  error: unknown;
  consecutiveExternalConflicts?: number;
  webhookPresent?: boolean;
  webhookUrl?: string | null;
}): TelegramTransportFailureClassification {
  const raw = normalizeErrorText(input.error);
  const normalized = raw.toLowerCase();
  const repeatedExternalConflict =
    (input.consecutiveExternalConflicts ?? 0) >= 1;
  const webhookUrl = input.webhookUrl?.trim() || null;

  if (
    normalized.includes('terminated by setwebhook request') ||
    normalized.includes('setwebhook request')
  ) {
    if (repeatedExternalConflict) {
      return {
        detail: buildSharedTokenDetail(webhookUrl),
        errorClass: 'token_rotation_required',
        status: 'blocked',
        externalConsumerSuspected: true,
        tokenRotationRequired: true,
      };
    }
    return {
      detail:
        'Telegram long polling was interrupted by a webhook change outside this runtime.',
      errorClass: 'setwebhook_conflict',
      status: 'degraded',
      externalConsumerSuspected: false,
      tokenRotationRequired: false,
    };
  }

  if (
    normalized.includes('terminated by other getupdates request') ||
    normalized.includes('another getupdates request') ||
    normalized.includes('other getupdates request')
  ) {
    if (repeatedExternalConflict) {
      return {
        detail:
          'Telegram long polling keeps colliding with another getUpdates consumer. Rotate the Telegram bot token and retire the competing consumer before trusting Telegram again.',
        errorClass: 'token_rotation_required',
        status: 'blocked',
        externalConsumerSuspected: true,
        tokenRotationRequired: true,
      };
    }
    return {
      detail:
        'Telegram long polling collided with another getUpdates consumer outside this runtime.',
      errorClass: 'getupdates_conflict',
      status: 'degraded',
      externalConsumerSuspected: false,
      tokenRotationRequired: false,
    };
  }

  if (input.webhookPresent) {
    if (repeatedExternalConflict) {
      return {
        detail: buildSharedTokenDetail(webhookUrl),
        errorClass: 'shared_token_suspected',
        status: 'blocked',
        externalConsumerSuspected: true,
        tokenRotationRequired: true,
      };
    }
    return {
      detail: webhookUrl
        ? `Telegram webhook ${webhookUrl} is active while this machine is configured for long polling only.`
        : 'Telegram webhook state is active while this machine is configured for long polling only.',
      errorClass: 'webhook_active',
      status: 'degraded',
      externalConsumerSuspected: true,
      tokenRotationRequired: false,
    };
  }

  return {
    detail: raw,
    errorClass: 'local_start_failure',
    status: 'degraded',
    externalConsumerSuspected: false,
    tokenRotationRequired: false,
  };
}
