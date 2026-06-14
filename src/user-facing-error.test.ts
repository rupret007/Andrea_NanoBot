import { describe, expect, it } from 'vitest';

import {
  formatUserFacingOperationFailure,
  getUserFacingErrorDetail,
  isUserFacingExternalDependencyDetail,
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
    ).toBe('The request timed out before it finished on my side.');
  });

  it('maps credit-balance failures to an external quota message', () => {
    expect(
      getUserFacingErrorDetail(new Error('Credit balance is too low')),
    ).toBe('The external service is rate-limited or out of quota right now.');
  });

  it('maps disabled runtime integrations to an external dependency message', () => {
    const detail = getUserFacingErrorDetail(
      new Error(
        'Andrea OpenAI backend is not enabled in this NanoBot runtime.',
      ),
    );

    expect(detail).toBe(
      'The external integration is not enabled in this runtime.',
    );
    expect(isUserFacingExternalDependencyDetail(detail)).toBe(true);
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
      'Something went wrong on my side while handling that request.',
    );
    expect(detail).not.toContain('stacktrace');
    expect(isUserFacingExternalDependencyDetail(detail)).toBe(false);
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
