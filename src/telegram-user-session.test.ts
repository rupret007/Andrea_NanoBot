import path from 'path';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TELEGRAM_LIVE_TEST_MESSAGES,
  normalizeTelegramTestTarget,
  resolveTelegramUserSessionConfig,
} from './telegram-user-session.js';

describe('normalizeTelegramTestTarget', () => {
  it('strips tg prefix from stored chat ids', () => {
    expect(normalizeTelegramTestTarget('tg:8004355504')).toBe('8004355504');
  });

  it('preserves usernames and numeric ids', () => {
    expect(normalizeTelegramTestTarget('@andrea_nanobot')).toBe(
      '@andrea_nanobot',
    );
    expect(normalizeTelegramTestTarget('8004355504')).toBe('8004355504');
  });
});

describe('resolveTelegramUserSessionConfig', () => {
  it('uses repo-local defaults when env is empty', () => {
    const config = resolveTelegramUserSessionConfig('/tmp/workspace', {});

    expect(config.apiId).toBeNull();
    expect(config.apiHash).toBe('');
    expect(config.session).toBe('');
    expect(config.sessionFile).toBe(
      path.join('/tmp/workspace', 'store', 'telegram-user.session'),
    );
    expect(config.testTarget).toBe('');
  });

  it('prefers explicit test target and session env values', () => {
    const config = resolveTelegramUserSessionConfig('/workspace', {
      TELEGRAM_USER_API_ID: '12345',
      TELEGRAM_USER_API_HASH: 'hash-value',
      TELEGRAM_USER_SESSION: 'session-string',
      TELEGRAM_TEST_TARGET: '@andrea_nanobot',
      TELEGRAM_USER_SESSION_FILE: '/workspace/custom.session',
      TELEGRAM_PHONE: '+15551234567',
      TELEGRAM_LIVE_REPLY_TIMEOUT_MS: '111',
      TELEGRAM_LIVE_REPLY_SETTLE_MS: '222',
    });

    expect(config.apiId).toBe(12345);
    expect(config.apiHash).toBe('hash-value');
    expect(config.session).toBe('session-string');
    expect(config.sessionFile).toBe('/workspace/custom.session');
    expect(config.testTarget).toBe('@andrea_nanobot');
    expect(config.phoneNumber).toBe('+15551234567');
    expect(config.replyTimeoutMs).toBe(111);
    expect(config.replySettleMs).toBe(222);
  });

  it('normalizes TELEGRAM_TEST_CHAT_ID when supplied as a stored jid', () => {
    const config = resolveTelegramUserSessionConfig('/workspace', {
      TELEGRAM_USER_API_ID: '12345',
      TELEGRAM_USER_API_HASH: 'hash-value',
      TELEGRAM_TEST_CHAT_ID: 'tg:8004355504',
    });

    expect(config.testTarget).toBe('8004355504');
  });
});

describe('DEFAULT_TELEGRAM_LIVE_TEST_MESSAGES', () => {
  it('keeps the core live test batch available for operator use', () => {
    expect(DEFAULT_TELEGRAM_LIVE_TEST_MESSAGES).toEqual([
      '/start',
      '/help',
      "What's the meaning of life?",
      'What is 56 + 778?',
      'Thanks',
      'ok',
      'Remind me tomorrow at 3pm to call Sam',
      '/cursor_status',
    ]);
  });
});
