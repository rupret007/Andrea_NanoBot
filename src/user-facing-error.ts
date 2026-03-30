function normalizeErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || '';
  return typeof err === 'string' ? err : '';
}

function includesAny(haystack: string, needles: readonly string[]): boolean {
  return needles.some((needle) => haystack.includes(needle));
}

export function getUserFacingErrorDetail(err: unknown): string {
  const message = normalizeErrorMessage(err).trim().toLowerCase();

  if (!message) {
    return 'Something went wrong on my side while handling that request.';
  }

  if (
    includesAny(message, [
      'timed out',
      'timeout',
      'deadline exceeded',
      'took too long',
    ])
  ) {
    return 'The request timed out before it finished on my side.';
  }

  if (
    includesAny(message, [
      'insufficient_quota',
      'quota',
      'rate limit',
      'rate-limit',
      'too many requests',
      '429',
    ])
  ) {
    return 'The external service is rate-limited or out of quota right now.';
  }

  if (
    includesAny(message, [
      'invalid_api_key',
      'authentication',
      'unauthorized',
      'forbidden',
      'permission denied',
      '401',
      '403',
    ])
  ) {
    return 'The external integration credentials were rejected.';
  }

  if (
    includesAny(message, [
      'not found',
      'no tracked',
      'does not exist',
      'unknown agent',
      '404',
    ])
  ) {
    return 'The requested item could not be found anymore.';
  }

  if (
    includesAny(message, [
      'already exists',
      'already enabled',
      'already disabled',
      'already registered',
      'already running',
    ])
  ) {
    return 'That request is already in the desired state.';
  }

  if (
    includesAny(message, [
      'econnrefused',
      'econnreset',
      'enotfound',
      'network',
      'socket hang up',
      'connect',
      'connection reset',
      'unreachable',
    ])
  ) {
    return 'The external integration is currently unreachable.';
  }

  if (
    includesAny(message, [
      'invalid',
      'malformed',
      'bad request',
      'missing required',
      'validation',
      'unprocessable',
      '400',
      '422',
    ])
  ) {
    return 'The request was rejected because some required input was invalid.';
  }

  return 'Something went wrong on my side while handling that request.';
}

export function formatUserFacingOperationFailure(
  prefix: string,
  err: unknown,
): string {
  const normalizedPrefix = prefix.trim().replace(/[. ]+$/, '');
  return `${normalizedPrefix}. ${getUserFacingErrorDetail(err)}`;
}
