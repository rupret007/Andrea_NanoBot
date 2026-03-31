import fs, { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_TELEGRAM_LIVE_TEST_MESSAGES,
  didTelegramReplyChange,
  matchesExpectedTelegramSender,
  normalizeTelegramSenderId,
  normalizeTelegramTestTarget,
  parseTelegramSendCommandArgs,
  parseTelegramTapCommandArgs,
  resolveTelegramTapButtonTarget,
  resolveTelegramUserSessionConfig,
  withTelegramUserSessionLock,
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

describe('normalizeTelegramSenderId', () => {
  it('normalizes primitive and peer-like sender ids', () => {
    expect(normalizeTelegramSenderId(12345)).toBe('12345');
    expect(normalizeTelegramSenderId(12345n)).toBe('12345');
    expect(normalizeTelegramSenderId(' 12345 ')).toBe('12345');
    expect(normalizeTelegramSenderId({ userId: 12345n })).toBe('12345');
    expect(normalizeTelegramSenderId({ channelId: '555' })).toBe('555');
  });
});

describe('matchesExpectedTelegramSender', () => {
  it('accepts any sender when no expectation is configured', () => {
    expect(matchesExpectedTelegramSender({ senderId: 123 }, null)).toBe(true);
  });

  it('matches only the expected sender id when provided', () => {
    expect(
      matchesExpectedTelegramSender({ senderId: { userId: 12345n } }, '12345'),
    ).toBe(true);
    expect(
      matchesExpectedTelegramSender({ senderId: { userId: 999n } }, '12345'),
    ).toBe(false);
  });
});

describe('resolveTelegramUserSessionConfig', () => {
  it('uses repo-local defaults when env is empty', () => {
    const config = resolveTelegramUserSessionConfig('/tmp/workspace', {}, {});

    expect(config.apiId).toBeNull();
    expect(config.apiHash).toBe('');
    expect(config.session).toBe('');
    expect(config.sessionFile).toBe(
      path.join('/tmp/workspace', 'store', 'telegram-user.session'),
    );
    expect(config.testTarget).toBe('');
    expect(config.authMode).toBe('qr');
    expect(config.twoFactorPassword).toBe('');
    expect(config.replyTimeoutMs).toBe(30000);
    expect(config.replySettleMs).toBe(1500);
  });

  it('prefers explicit test target and session env values', () => {
    const config = resolveTelegramUserSessionConfig(
      '/workspace',
      {
        TELEGRAM_USER_API_ID: '12345',
        TELEGRAM_USER_API_HASH: 'hash-value',
        TELEGRAM_USER_SESSION: 'session-string',
        TELEGRAM_TEST_TARGET: '@andrea_nanobot',
        TELEGRAM_USER_SESSION_FILE: '/workspace/custom.session',
        TELEGRAM_PHONE: '+15551234567',
        TELEGRAM_USER_AUTH_MODE: 'phone',
        TELEGRAM_USER_2FA_PASSWORD: 'pw',
        TELEGRAM_LIVE_REPLY_TIMEOUT_MS: '111',
        TELEGRAM_LIVE_REPLY_SETTLE_MS: '222',
      },
      {},
    );

    expect(config.apiId).toBe(12345);
    expect(config.apiHash).toBe('hash-value');
    expect(config.session).toBe('session-string');
    expect(config.sessionFile).toBe('/workspace/custom.session');
    expect(config.testTarget).toBe('@andrea_nanobot');
    expect(config.phoneNumber).toBe('+15551234567');
    expect(config.authMode).toBe('phone');
    expect(config.twoFactorPassword).toBe('pw');
    expect(config.replyTimeoutMs).toBe(111);
    expect(config.replySettleMs).toBe(222);
  });

  it('normalizes TELEGRAM_TEST_CHAT_ID when supplied as a stored jid', () => {
    const config = resolveTelegramUserSessionConfig(
      '/workspace',
      {
        TELEGRAM_USER_API_ID: '12345',
        TELEGRAM_USER_API_HASH: 'hash-value',
        TELEGRAM_TEST_CHAT_ID: 'tg:8004355504',
      },
      {},
    );

    expect(config.testTarget).toBe('8004355504');
    expect(config.authMode).toBe('qr');
  });
});

describe('parseTelegramSendCommandArgs', () => {
  it('parses plain message text with no reply target', () => {
    expect(parseTelegramSendCommandArgs(['hello', 'Andrea'])).toEqual({
      message: 'hello Andrea',
      replyToMessageId: undefined,
    });
  });

  it('parses --reply-to message metadata for reply-linked operator flows', () => {
    expect(
      parseTelegramSendCommandArgs(['--reply-to', '1234', '/cursor-sync']),
    ).toEqual({
      message: '/cursor-sync',
      replyToMessageId: 1234,
    });
  });

  it('rejects malformed send arguments', () => {
    expect(() => parseTelegramSendCommandArgs([])).toThrow('Usage:');
    expect(() =>
      parseTelegramSendCommandArgs(['--reply-to', 'oops', '/cursor-sync']),
    ).toThrow('Usage:');
  });
});

describe('parseTelegramTapCommandArgs', () => {
  it('parses a target message id and button selection', () => {
    expect(parseTelegramTapCommandArgs(['321', 'Terminal', 'Log'])).toEqual({
      messageId: 321,
      selection: 'Terminal Log',
    });
  });

  it('rejects malformed tap arguments', () => {
    expect(() => parseTelegramTapCommandArgs(['321'])).toThrow('Usage:');
    expect(() => parseTelegramTapCommandArgs(['oops', '1'])).toThrow('Usage:');
  });
});

describe('resolveTelegramTapButtonTarget', () => {
  it('prefers exact label matches before numeric index selection', () => {
    expect(
      resolveTelegramTapButtonTarget(['Sync', 'Text', 'Files'], 'Text'),
    ).toEqual({
      index: 2,
      label: 'Text',
    });
  });

  it('falls back to case-insensitive labels and 1-based indices', () => {
    expect(
      resolveTelegramTapButtonTarget(['Sync', 'Text', 'Files'], 'files'),
    ).toEqual({
      index: 3,
      label: 'Files',
    });
    expect(resolveTelegramTapButtonTarget(['Sync', 'Text'], '1')).toEqual({
      index: 1,
      label: 'Sync',
    });
  });

  it('reports available buttons when selection fails', () => {
    expect(() =>
      resolveTelegramTapButtonTarget(['Sync', 'Text'], 'Stop'),
    ).toThrow('Available buttons: Sync, Text');
  });
});

describe('didTelegramReplyChange', () => {
  it('detects edited dashboard text and button changes', () => {
    expect(
      didTelegramReplyChange(
        { id: 1, text: 'Old', buttonLabels: ['Jobs'] },
        { id: 1, text: 'New', buttonLabels: ['Jobs', 'Help'] },
      ),
    ).toBe(true);
    expect(
      didTelegramReplyChange(
        { id: 1, text: 'Same', buttonLabels: ['Jobs'] },
        { id: 1, text: 'Same', buttonLabels: ['Jobs'] },
      ),
    ).toBe(false);
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

describe('withTelegramUserSessionLock', () => {
  it('rejects concurrent harness runs for the same session file', async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-tg-lock-'));
    const sessionFile = path.join(tempDir, 'telegram-user.session');
    const lockFile = path.join(tempDir, 'telegram-user-session.lock');
    fs.writeFileSync(
      lockFile,
      `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
      'utf8',
    );

    const setTimeoutSpy = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation(((callback: Parameters<typeof setTimeout>[0]) => {
        queueMicrotask(() => {
          if (typeof callback === 'function') callback();
        });
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout);
    try {
      await expect(
        withTelegramUserSessionLock(sessionFile, async () => {
          throw new Error('should not run while a live lock exists');
        }),
      ).rejects.toThrow('already running');
    } finally {
      setTimeoutSpy.mockRestore();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('retries a transient lock collision before succeeding', async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-tg-lock-'));
    const sessionFile = path.join(tempDir, 'telegram-user.session');
    const originalOpen = fs.promises.open.bind(fs.promises);
    let attempts = 0;
    const openSpy = vi
      .spyOn(fs.promises, 'open')
      .mockImplementation(async (...args) => {
        attempts += 1;
        if (attempts === 1) {
          const error = new Error('exists') as NodeJS.ErrnoException;
          error.code = 'EEXIST';
          throw error;
        }
        return originalOpen(...args);
      });

    try {
      let ran = false;
      await withTelegramUserSessionLock(sessionFile, async () => {
        ran = true;
      });
      expect(ran).toBe(true);
      expect(attempts).toBeGreaterThanOrEqual(2);
    } finally {
      openSpy.mockRestore();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('clears a stale lock file from a dead process before running', async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-tg-lock-'));
    const sessionFile = path.join(tempDir, 'telegram-user.session');
    const lockFile = path.join(tempDir, 'telegram-user-session.lock');
    fs.writeFileSync(
      lockFile,
      `${JSON.stringify({ pid: 999999, startedAt: new Date().toISOString() })}\n`,
      'utf8',
    );

    try {
      let ran = false;
      await withTelegramUserSessionLock(sessionFile, async () => {
        ran = true;
      });
      expect(ran).toBe(true);
      expect(fs.existsSync(lockFile)).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
