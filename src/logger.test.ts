import { describe, expect, it } from 'vitest';

import { sanitizeLogData, sanitizeLogString } from './logger.js';

describe('sanitizeLogString', () => {
  it('redacts assignment-style secrets', () => {
    const redacted = sanitizeLogString(
      'OPENAI_API_KEY=sk-test-secret ANTHROPIC_AUTH_TOKEN=token-123 TELEGRAM_USER_SESSION=very-secret-session',
    );

    expect(redacted).toContain('OPENAI_API_KEY=***');
    expect(redacted).toContain('ANTHROPIC_AUTH_TOKEN=***');
    expect(redacted).toContain('TELEGRAM_USER_SESSION=***');
    expect(redacted).not.toContain('sk-test-secret');
    expect(redacted).not.toContain('token-123');
    expect(redacted).not.toContain('very-secret-session');
  });

  it('redacts bearer headers and token-like key values', () => {
    const redacted = sanitizeLogString(
      'Authorization: Bearer abcdefghijklmnop and fallback sk-proj-super-secret',
    );

    expect(redacted).toContain('Authorization: Bearer ***');
    expect(redacted).toContain('sk-***');
    expect(redacted).not.toContain('abcdefghijklmnop');
    expect(redacted).not.toContain('sk-proj-super-secret');
  });

  it('redacts Cursor dashboard-style keys', () => {
    const redacted = sanitizeLogString(
      'Cursor key key_abcdefghijklmnopqrstuvwxyz0123456789',
    );

    expect(redacted).toContain('key_***');
    expect(redacted).not.toContain('key_abcdefghijklmnopqrstuvwxyz0123456789');
  });
});

describe('sanitizeLogData', () => {
  it('redacts nested data structures', () => {
    const sanitized = sanitizeLogData({
      message: 'request failed for OPENAI_API_KEY=sk-live-abc123',
      nested: {
        authorization: 'Bearer token-secret-value',
        arr: [
          'cursor_api_abcdef123456',
          'key_abcdefghijklmnopqrstuvwxyz0123456789',
          'safe',
        ],
      },
    });
    const serialized = JSON.stringify(sanitized);

    expect(serialized).toContain('OPENAI_API_KEY=***');
    expect(serialized).toContain('Bearer ***');
    expect(serialized).toContain('cursor_api_***');
    expect(serialized).toContain('key_***');
    expect(serialized).not.toContain('sk-live-abc123');
    expect(serialized).not.toContain('token-secret-value');
    expect(serialized).not.toContain('cursor_api_abcdef123456');
    expect(serialized).not.toContain(
      'key_abcdefghijklmnopqrstuvwxyz0123456789',
    );
  });
});
