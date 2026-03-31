import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import { describe, expect, it } from 'vitest';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const runtimeClassifierPath = path.join(
  currentDir,
  '..',
  'container',
  'agent-runner',
  'src',
  'runtime-error-classification.ts',
);

type DirectAssistantClassifier = (
  subtype: string | undefined,
  textResult: string | null,
  resultErrors: string[],
) => {
  retryable: boolean;
  failureKind:
    | 'insufficient_quota'
    | 'auth_failed'
    | 'invalid_model_alias'
    | 'unsupported_endpoint'
    | 'runtime_bootstrap_failed';
};

type DirectAssistantRecoveryRetryPlanner = (sessionId: string | undefined) => {
  sessionId: string | undefined;
  resumeAt: string | undefined;
  startsFreshSession: boolean;
};

async function loadClassifier(): Promise<{
  classifyDirectAssistantError: DirectAssistantClassifier;
  isDirectAssistantErrorText: (
    textResult: string | null | undefined,
  ) => boolean;
}> {
  return import(pathToFileURL(runtimeClassifierPath).href);
}

const retryPlannerPath = path.join(
  currentDir,
  '..',
  'container',
  'agent-runner',
  'src',
  'direct-assistant-retry.ts',
);

async function loadRetryPlanner(): Promise<{
  planDirectAssistantRecoveryRetry: DirectAssistantRecoveryRetryPlanner;
}> {
  return import(pathToFileURL(retryPlannerPath).href);
}

describe('classifyDirectAssistantError', () => {
  it('treats raw API error text as an execution error signal', async () => {
    const { isDirectAssistantErrorText } = await loadClassifier();

    expect(
      isDirectAssistantErrorText(
        `API Error: 400 {"error":{"message":"Invalid model name"}}`,
      ),
    ).toBe(true);
    expect(isDirectAssistantErrorText('Here is a normal answer.')).toBe(false);
  });

  it('keeps transient transport failures retryable', async () => {
    const { classifyDirectAssistantError } = await loadClassifier();
    const classification = classifyDirectAssistantError(
      'error_transport',
      'fetch failed ECONNRESET',
      [],
    );

    expect(classification.retryable).toBe(true);
    expect(classification.failureKind).toBe('runtime_bootstrap_failed');
  });

  it('does not retry authentication failures', async () => {
    const { classifyDirectAssistantError } = await loadClassifier();
    const classification = classifyDirectAssistantError(
      'error_auth',
      'Gateway authentication failed because the API key is invalid.',
      [],
    );

    expect(classification.retryable).toBe(false);
    expect(classification.failureKind).toBe('auth_failed');
  });

  it('does not retry invalid model failures', async () => {
    const { classifyDirectAssistantError } = await loadClassifier();
    const classification = classifyDirectAssistantError(
      'error_model',
      'Invalid model name passed in model=claude-sonnet-4-6',
      [],
    );

    expect(classification.retryable).toBe(false);
    expect(classification.failureKind).toBe('invalid_model_alias');
  });

  it('detects invalid model failures from thrown API error text', async () => {
    const { classifyDirectAssistantError } = await loadClassifier();
    const classification = classifyDirectAssistantError(
      undefined,
      `API Error: 400 {"error":{"message":"400: {'error': 'anthropic_messages: Invalid model name passed in model=definitely-invalid-model. Call \`/v1/models\` to view available models for your key.'}"}}`,
      [],
    );

    expect(classification.retryable).toBe(false);
    expect(classification.failureKind).toBe('invalid_model_alias');
  });
});

describe('planDirectAssistantRecoveryRetry', () => {
  it('drops resumed session state on recovery retry', async () => {
    const { planDirectAssistantRecoveryRetry } = await loadRetryPlanner();

    expect(planDirectAssistantRecoveryRetry('session-123')).toEqual({
      sessionId: undefined,
      resumeAt: undefined,
      startsFreshSession: true,
    });
  });

  it('keeps retry planning simple when there is no existing session', async () => {
    const { planDirectAssistantRecoveryRetry } = await loadRetryPlanner();

    expect(planDirectAssistantRecoveryRetry(undefined)).toEqual({
      sessionId: undefined,
      resumeAt: undefined,
      startsFreshSession: false,
    });
  });
});
