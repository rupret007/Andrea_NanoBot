export type DirectAssistantFailureKind =
  | 'insufficient_quota'
  | 'auth_failed'
  | 'invalid_model_alias'
  | 'unsupported_endpoint'
  | 'runtime_bootstrap_failed';

export interface DirectAssistantErrorClassification {
  retryable: boolean;
  failureKind: DirectAssistantFailureKind;
  diagnosticHint: string;
  reason: string;
}

function includesAny(haystack: string, needles: string[]): boolean {
  return needles.some((needle) => haystack.includes(needle));
}

function normalizeErrorContext(
  subtype: string | undefined,
  textResult: string | null,
  resultErrors: string[],
): string {
  return [subtype, textResult, ...resultErrors]
    .filter((entry): entry is string => Boolean(entry?.trim()))
    .join(' | ')
    .toLowerCase();
}

export function isDirectAssistantErrorText(
  textResult: string | null | undefined,
): boolean {
  const normalized = textResult?.trim().toLowerCase() || '';
  return (
    normalized.startsWith('api error:') ||
    normalized.startsWith('error: api error:') ||
    normalized.includes('claude code returned an error result: api error:')
  );
}

export function classifyDirectAssistantError(
  subtype: string | undefined,
  textResult: string | null,
  resultErrors: string[],
): DirectAssistantErrorClassification {
  const message = normalizeErrorContext(subtype, textResult, resultErrors);

  if (message.includes('insufficient_quota')) {
    return {
      retryable: false,
      failureKind: 'insufficient_quota',
      diagnosticHint:
        'assistant runtime returned an insufficient quota error before producing a stable answer',
      reason: 'insufficient_quota',
    };
  }

  if (
    includesAny(message, [
      'invalid_api_key',
      'invalid api key',
      'incorrect api key',
      'api key is invalid',
      'authentication failed',
      'auth failed',
      'unauthorized',
      'forbidden',
      'permission denied',
    ])
  ) {
    return {
      retryable: false,
      failureKind: 'auth_failed',
      diagnosticHint:
        'assistant runtime returned an authentication failure before producing a stable answer',
      reason: 'auth_failed',
    };
  }

  if (
    includesAny(message, [
      'invalid model name',
      'invalid model',
      'model_not_found',
      'unknown model',
      'model alias',
    ])
  ) {
    return {
      retryable: false,
      failureKind: 'invalid_model_alias',
      diagnosticHint:
        'assistant runtime returned an invalid model failure before producing a stable answer',
      reason: 'invalid_model_alias',
    };
  }

  if (
    (message.includes('/v1/messages') && message.includes('404')) ||
    includesAny(message, [
      'anthropic-compatible',
      'unsupported endpoint',
      'messages endpoint is missing',
    ])
  ) {
    return {
      retryable: false,
      failureKind: 'unsupported_endpoint',
      diagnosticHint:
        'assistant runtime returned an endpoint compatibility failure before producing a stable answer',
      reason: 'unsupported_endpoint',
    };
  }

  return {
    retryable: true,
    failureKind: 'runtime_bootstrap_failed',
    diagnosticHint: includesAny(message, [
      'econnreset',
      'econnrefused',
      'fetch failed',
      'socket hang up',
      'timed out',
      'timeout',
      'connection reset',
      'connection refused',
      'network',
    ])
      ? 'assistant runtime hit a transient transport failure before producing a stable answer'
      : 'assistant runtime hit a transient execution failure before producing a stable answer',
    reason: includesAny(message, [
      'econnreset',
      'econnrefused',
      'fetch failed',
      'socket hang up',
      'timed out',
      'timeout',
      'connection reset',
      'connection refused',
      'network',
    ])
      ? 'transient_transport_failure'
      : 'transient_execution_failure',
  };
}
