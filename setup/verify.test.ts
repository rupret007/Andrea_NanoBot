import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildCredentialProbeMessagesUrl,
  classifyCredentialProbeFailure,
  determineCredentialStatus,
  isLikelyNativeOpenAiEndpoint,
  probeAssistantExecution,
  probeCredentialRuntime,
  resolveCredentialProbeEndpoints,
} from './verify.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('determineCredentialStatus', () => {
  it('requires actual credential material when OneCLI is only reachable', () => {
    const status = determineCredentialStatus({
      hasAnthropicDirectCredential: false,
      hasOpenAiCompatibleCredential: false,
      onecliReachable: true,
      onecliCredentialKeys: [],
    });

    expect(status).toEqual({
      credentials: 'missing',
      credentialMode: 'missing',
      credentialSources: '',
      onecliCredentialStatus: 'reachable_credentials_unverified',
    });
  });

  it('marks onecli credentials configured when keys are present', () => {
    const status = determineCredentialStatus({
      hasAnthropicDirectCredential: false,
      hasOpenAiCompatibleCredential: false,
      onecliReachable: true,
      onecliCredentialKeys: ['OPENAI_API_KEY'],
    });

    expect(status).toEqual({
      credentials: 'configured',
      credentialMode: 'onecli',
      credentialSources: 'onecli',
      onecliCredentialStatus: 'configured',
    });
  });

  it('prefers env mode when OpenAI-compatible env credentials are present', () => {
    const status = determineCredentialStatus({
      hasAnthropicDirectCredential: false,
      hasOpenAiCompatibleCredential: true,
      onecliReachable: false,
      onecliCredentialKeys: [],
    });

    expect(status).toEqual({
      credentials: 'configured',
      credentialMode: 'openai_compat',
      credentialSources: 'env',
      onecliCredentialStatus: 'unreachable',
    });
  });
});

describe('isLikelyNativeOpenAiEndpoint', () => {
  it('detects the native OpenAI host', () => {
    expect(isLikelyNativeOpenAiEndpoint('https://api.openai.com/v1')).toBe(
      true,
    );
    expect(isLikelyNativeOpenAiEndpoint('api.openai.com/v1')).toBe(true);
  });

  it('does not flag Anthropic-compatible gateway hosts', () => {
    expect(isLikelyNativeOpenAiEndpoint('https://gateway.example.com')).toBe(
      false,
    );
    expect(isLikelyNativeOpenAiEndpoint('https://claude-proxy.local/v1')).toBe(
      false,
    );
  });
});

describe('classifyCredentialProbeFailure', () => {
  it('classifies insufficient quota responses', () => {
    const result = classifyCredentialProbeFailure({
      statusCode: 429,
      body: '{"error":{"code":"insufficient_quota"}}',
    });
    expect(result.reason).toBe('insufficient_quota');
  });

  it('classifies invalid model responses', () => {
    const result = classifyCredentialProbeFailure({
      statusCode: 400,
      body: 'Invalid model name passed in model=claude-sonnet-4-6',
    });
    expect(result.reason).toBe('invalid_model_alias');
  });

  it('classifies network failures', () => {
    const result = classifyCredentialProbeFailure({
      errorMessage: 'fetch failed: connect ECONNREFUSED',
    });
    expect(result.reason).toBe('network_error');
  });

  it('does not misclassify invalid max token errors as model alias failures', () => {
    const result = classifyCredentialProbeFailure({
      statusCode: 400,
      body: "Invalid 'max_output_tokens': integer below minimum value.",
    });
    expect(result.reason).toBe('http_400');
  });
});

describe('resolveCredentialProbeEndpoints', () => {
  it('adds localhost fallback for host-only aliases and gateway host health', () => {
    const endpoints = resolveCredentialProbeEndpoints({
      configuredEndpoint: 'http://host.containers.internal:4000',
      gatewayState: {
        endpoint: 'http://litellm-gateway:4000',
        host_health: 'http://127.0.0.1:4000/health',
      },
    });

    expect(endpoints).toEqual([
      'http://host.containers.internal:4000',
      'http://127.0.0.1:4000',
      'http://litellm-gateway:4000',
    ]);
  });
});

describe('buildCredentialProbeMessagesUrl', () => {
  it('appends /v1/messages for plain gateway roots', () => {
    expect(buildCredentialProbeMessagesUrl('http://127.0.0.1:4000')).toBe(
      'http://127.0.0.1:4000/v1/messages',
    );
  });

  it('avoids duplicate /v1 segments', () => {
    expect(buildCredentialProbeMessagesUrl('http://127.0.0.1:4000/v1')).toBe(
      'http://127.0.0.1:4000/v1/messages',
    );
  });
});

describe('probeCredentialRuntime', () => {
  it('retries host-local endpoints through transient network failures', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls += 1;
      if (calls < 3) {
        throw new Error('fetch failed: connect ECONNRESET');
      }
      return new Response('{"type":"message"}', { status: 200 });
    });

    const result = await probeCredentialRuntime({
      endpoints: ['http://127.0.0.1:4000'],
      authToken: 'test-key',
      model: 'claude-sonnet-4-5',
      maxHostLocalAttempts: 3,
      requestTimeoutMs: 50,
      retryDelayMs: 0,
    });

    expect(result).toEqual({
      status: 'ok',
      reason: 'ok',
    });
    expect(calls).toBe(3);
  });

  it('does not endlessly retry non-local endpoints on network failure', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls += 1;
      throw new Error('fetch failed: connect ECONNREFUSED');
    });

    const result = await probeCredentialRuntime({
      endpoints: ['http://gateway.example.com'],
      authToken: 'test-key',
      model: 'claude-sonnet-4-5',
      maxHostLocalAttempts: 5,
      requestTimeoutMs: 50,
      retryDelayMs: 0,
    });

    expect(result.status).toBe('failed');
    expect(result.reason).toBe('network_error');
    expect(calls).toBe(1);
  });
});

describe('probeAssistantExecution', () => {
  it('reports failure when the assistant runtime times out before first output', async () => {
    const result = await probeAssistantExecution({
      requestClose: () => {},
      runProbe: async () => ({
        status: 'error',
        result: null,
        error: 'Container produced no structured output within 20000ms.',
        failureKind: 'initial_output_timeout',
        failureStage: 'startup',
        diagnosticHint:
          'container did not emit first structured result before timeout',
      }),
    });

    expect(result).toEqual({
      status: 'failed',
      reason: 'initial_output_timeout',
      detail: 'container did not emit first structured result before timeout',
    });
  });

  it('reports success when structured assistant output is observed', async () => {
    const result = await probeAssistantExecution({
      requestClose: () => {},
      runProbe: async (_group, _input, _onProcess, onOutput) => {
        await onOutput?.({
          status: 'success',
          result: 'assistant execution probe ok.',
          newSessionId: 'probe-session',
        });
        return {
          status: 'success',
          result: null,
          newSessionId: 'probe-session',
        };
      },
    });

    expect(result.status).toBe('ok');
    expect(result.reason).toBe('ok');
    expect(result.detail).toContain('assistant execution produced a real assistant answer');
  });

  it('fails when the probe only sees lifecycle output', async () => {
    const result = await probeAssistantExecution({
      requestClose: () => {},
      runProbe: async (_group, _input, _onProcess, onOutput) => {
        await onOutput?.({
          status: 'success',
          result: null,
          newSessionId: 'probe-session',
          sawLifecycleOnlyOutput: true,
        });
        return {
          status: 'success',
          result: null,
          newSessionId: 'probe-session',
          sawLifecycleOnlyOutput: true,
        };
      },
    });

    expect(result.status).toBe('failed');
    expect(result.reason).toBe('runtime_bootstrap_failed');
    expect(result.detail).toContain('lifecycle output');
  });

  it('includes retry detail when the probe exhausted one recovery retry', async () => {
    const result = await probeAssistantExecution({
      requestClose: () => {},
      runProbe: async () => ({
        status: 'error',
        result: null,
        error: 'Container exited with code 1.',
        failureKind: 'runtime_bootstrap_failed',
        failureStage: 'runtime',
        diagnosticHint:
          'assistant runtime hit a transient execution failure before producing a stable answer',
        recoveryAttempted: true,
      }),
    });

    expect(result.status).toBe('failed');
    expect(result.detail).toContain('recovery retry');
  });
});
