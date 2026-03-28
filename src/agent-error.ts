export interface AgentErrorAnalysis {
  code:
    | 'insufficient_quota'
    | 'auth_failed'
    | 'invalid_model_alias'
    | 'unsupported_endpoint'
    | 'credentials_missing_or_unusable'
    | 'transient_or_unknown';
  nonRetriable: boolean;
  userMessage: string | null;
}

function includesAny(haystack: string, needles: string[]): boolean {
  return needles.some((needle) => haystack.includes(needle));
}

export function analyzeAgentError(
  errorMessage: string | undefined,
): AgentErrorAnalysis {
  const message = (errorMessage || '').toLowerCase();

  if (!message.trim()) {
    return {
      code: 'transient_or_unknown',
      nonRetriable: false,
      userMessage: null,
    };
  }

  if (message.includes('insufficient_quota')) {
    return {
      code: 'insufficient_quota',
      nonRetriable: true,
      userMessage:
        'I cannot run right now because the configured OpenAI key is out of quota. Top up billing, replace OPENAI_API_KEY, or switch to ANTHROPIC_* credentials.',
    };
  }

  if (
    includesAny(message, [
      'invalid_api_key',
      'authentication',
      'unauthorized',
      'forbidden',
      'permission denied',
    ])
  ) {
    return {
      code: 'auth_failed',
      nonRetriable: true,
      userMessage:
        'I cannot run right now because model authentication failed. Check OPENAI_API_KEY / ANTHROPIC_AUTH_TOKEN and the configured endpoint.',
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
      code: 'invalid_model_alias',
      nonRetriable: true,
      userMessage:
        'I cannot run right now because the configured model is not supported by the gateway. Set NANOCLAW_AGENT_MODEL to a supported alias (for example claude-3-5-sonnet-latest).',
    };
  }

  if (message.includes('/v1/messages') && message.includes('404')) {
    return {
      code: 'unsupported_endpoint',
      nonRetriable: true,
      userMessage:
        'I cannot run right now because the configured endpoint is not Anthropic-compatible (/v1/messages is missing). Use an Anthropic-compatible gateway endpoint.',
    };
  }

  if (
    includesAny(message, [
      'check credentials/channel setup',
      'missing credentials',
      'credential',
      'api key',
    ])
  ) {
    return {
      code: 'credentials_missing_or_unusable',
      nonRetriable: true,
      userMessage:
        'I cannot run right now because credentials are missing or unusable for the current model endpoint. Re-run setup verify and fix credential runtime checks.',
    };
  }

  return {
    code: 'transient_or_unknown',
    nonRetriable: false,
    userMessage: null,
  };
}
