import type { ContainerOutput } from './container-runner.js';

export interface AgentErrorAnalysis {
  code:
    | 'insufficient_quota'
    | 'auth_failed'
    | 'invalid_model_alias'
    | 'unsupported_endpoint'
    | 'initial_output_timeout'
    | 'runtime_bootstrap_failed'
    | 'container_runtime_unavailable'
    | 'credentials_missing_or_unusable'
    | 'transient_or_unknown';
  nonRetriable: boolean;
  userMessage: string | null;
}

export function buildRepeatedAgentErrorMessage(
  code: AgentErrorAnalysis['code'],
): string {
  switch (code) {
    case 'insufficient_quota':
      return 'I still cannot run right now because the configured model quota is exhausted.';
    case 'auth_failed':
    case 'invalid_model_alias':
    case 'unsupported_endpoint':
    case 'credentials_missing_or_unusable':
      return 'I still cannot run right now because the current model/runtime configuration needs operator attention.';
    case 'container_runtime_unavailable':
    case 'initial_output_timeout':
    case 'runtime_bootstrap_failed':
      return "I still can't answer from the assistant runtime right now. An operator can re-run setup verify and inspect the runtime logs.";
    case 'transient_or_unknown':
    default:
      return "I still can't run that right now.";
  }
}

type AgentErrorInput =
  | string
  | undefined
  | Pick<
      ContainerOutput,
      | 'error'
      | 'failureKind'
      | 'failureStage'
      | 'diagnosticHint'
      | 'selectedModel'
      | 'endpointMode'
      | 'stderrTail'
    >;

function includesAny(haystack: string, needles: string[]): boolean {
  return needles.some((needle) => haystack.includes(needle));
}

function analyzeStructuredFailure(
  input:
    | Pick<
        ContainerOutput,
        | 'error'
        | 'failureKind'
        | 'failureStage'
        | 'diagnosticHint'
        | 'selectedModel'
        | 'endpointMode'
      >
    | undefined,
): AgentErrorAnalysis | null {
  if (!input?.failureKind) return null;

  switch (input.failureKind) {
    case 'insufficient_quota':
      return {
        code: 'insufficient_quota',
        nonRetriable: true,
        userMessage:
          'I cannot run right now because the configured OpenAI key is out of quota. Top up billing, replace OPENAI_API_KEY, or switch to ANTHROPIC_* credentials.',
      };
    case 'auth_failed':
      return {
        code: 'auth_failed',
        nonRetriable: true,
        userMessage:
          'I cannot run right now because model authentication failed. Check OPENAI_API_KEY / ANTHROPIC_AUTH_TOKEN and the configured endpoint.',
      };
    case 'invalid_model_alias':
      return {
        code: 'invalid_model_alias',
        nonRetriable: true,
        userMessage:
          'I cannot run right now because the configured model is not supported by the gateway. Set NANOCLAW_AGENT_MODEL to a supported alias.',
      };
    case 'unsupported_endpoint':
      return {
        code: 'unsupported_endpoint',
        nonRetriable: true,
        userMessage:
          'I cannot run right now because the configured endpoint is not Anthropic-compatible (/v1/messages is missing). Use an Anthropic-compatible gateway endpoint.',
      };
    case 'container_runtime_unavailable':
      return {
        code: 'container_runtime_unavailable',
        nonRetriable: false,
        userMessage:
          'Andrea cannot run that assistant turn right now because the container runtime could not start cleanly. An operator should re-run setup verify and inspect the runtime logs.',
      };
    case 'initial_output_timeout':
      return {
        code: 'initial_output_timeout',
        nonRetriable: false,
        userMessage:
          'Andrea cannot run that assistant turn right now because the runtime failed before first output. This is different from a plain credential failure. An operator should re-run setup verify and inspect execution readiness logs.',
      };
    case 'runtime_bootstrap_failed':
      return {
        code: 'runtime_bootstrap_failed',
        nonRetriable: false,
        userMessage:
          'Andrea cannot run that assistant turn right now because the runtime failed during startup or execution. An operator should re-run setup verify and inspect execution readiness logs.',
      };
    case 'credentials_missing_or_unusable':
      return {
        code: 'credentials_missing_or_unusable',
        nonRetriable: true,
        userMessage:
          'I cannot run right now because credentials are missing or unusable for the current model endpoint. Re-run setup verify and fix credential runtime checks.',
      };
    default:
      return null;
  }
}

export function analyzeAgentError(
  errorInput: AgentErrorInput,
): AgentErrorAnalysis {
  if (typeof errorInput === 'object' && errorInput !== null) {
    const structured = analyzeStructuredFailure(errorInput);
    if (structured) return structured;
  }

  const errorMessage =
    typeof errorInput === 'string'
      ? errorInput
      : typeof errorInput?.error === 'string'
        ? errorInput.error
        : '';
  const message = errorMessage.toLowerCase();

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

  if (includesAny(message, ['missing credentials', 'credential', 'api key'])) {
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
