import { describe, expect, it } from 'vitest';

import {
  buildCredentialProbeMessagesUrl,
  classifyCredentialProbeFailure,
  determineCredentialStatus,
  isLikelyNativeOpenAiEndpoint,
  resolveCredentialProbeEndpoints,
} from './verify.js';

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
    expect(isLikelyNativeOpenAiEndpoint('https://api.openai.com/v1')).toBe(true);
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
      body: "Invalid model name passed in model=claude-sonnet-4-6",
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
