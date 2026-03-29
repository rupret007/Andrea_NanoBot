import { describe, expect, it } from 'vitest';

import {
  formatUserFacingOperationFailure,
  getUserFacingErrorDetail,
} from './user-facing-error.js';

describe('getUserFacingErrorDetail', () => {
  it('maps authentication failures to a safe credential message', () => {
    const detail = getUserFacingErrorDetail(
      new Error(
        '401 unauthorized for https://cursor.example/v1 using token sk-proj-secret',
      ),
    );

    expect(detail).toBe('The external integration credentials were rejected.');
    expect(detail).not.toContain('https://cursor.example/v1');
    expect(detail).not.toContain('sk-proj-secret');
  });

  it('maps timeouts to a concise timeout message', () => {
    expect(
      getUserFacingErrorDetail(new Error('request timed out after 30000ms')),
    ).toBe('The request timed out before the helper finished.');
  });

  it('maps not-found failures to a safe missing-item message', () => {
    expect(
      getUserFacingErrorDetail(new Error('Cursor agent bc_123 not found')),
    ).toBe('The requested item could not be found anymore.');
  });

  it('falls back to a generic internal error message for unknown failures', () => {
    const detail = getUserFacingErrorDetail(
      new Error('stacktrace: undefined is not a function'),
    );

    expect(detail).toBe(
      'The helper hit an internal error while handling that request.',
    );
    expect(detail).not.toContain('stacktrace');
  });
});

describe('formatUserFacingOperationFailure', () => {
  it('combines an operation prefix with the sanitized detail', () => {
    expect(
      formatUserFacingOperationFailure(
        "I couldn't start that Cursor agent job",
        new Error('ECONNREFUSED connecting to 127.0.0.1:20128'),
      ),
    ).toBe(
      "I couldn't start that Cursor agent job. The external integration is currently unreachable.",
    );
  });
});
