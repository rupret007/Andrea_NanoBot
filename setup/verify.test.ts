import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildVerifyAlexaProofAssessment,
  buildBlockedAssistantExecutionProbeResult,
  buildCredentialProbeMessagesUrl,
  buildReportedMissingRequirements,
  buildVerifyNextSteps,
  classifyLocalGatewayHealthPayload,
  classifyCredentialProbeFailure,
  determineCredentialStatus,
  isLikelyNativeOpenAiEndpoint,
  probeAssistantExecution,
  probeCredentialRuntime,
  probeLocalGatewayHealth,
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

  it('treats auto local-gateway binding as configured core-runtime credentials', () => {
    const status = determineCredentialStatus({
      hasAnthropicDirectCredential: false,
      hasOpenAiCompatibleCredential: false,
      hasAutoLocalGatewayCredential: true,
      onecliReachable: false,
      onecliCredentialKeys: [],
    });

    expect(status).toEqual({
      credentials: 'configured',
      credentialMode: 'openai_compat_local_gateway_auto',
      credentialSources: 'env,runtime_state',
      onecliCredentialStatus: 'unreachable',
    });
  });
});

describe('buildVerifyNextSteps', () => {
  it('calls out outward research separately when the local runtime backend is healthy', () => {
    const steps = buildVerifyNextSteps({
      missingRequirements: ['credentials'],
      hasNativeOpenAiEndpointMisconfig: false,
      runtimeBackendLocalExecutionState: 'available_authenticated',
    });

    expect(steps).toContain(
      'Outward research is blocked because direct provider credentials are missing.',
    );
    expect(steps).toContain(
      'The local runtime backend is healthy, so work-cockpit flows can still run on this host.',
    );
  });

  it('calls out quota-blocked outward research explicitly', () => {
    const steps = buildVerifyNextSteps({
      missingRequirements: ['credentials'],
      hasNativeOpenAiEndpointMisconfig: false,
      credentialRuntimeProbeReason: 'insufficient_quota',
      outwardResearchStatus: 'quota_blocked',
      runtimeBackendLocalExecutionState: 'available_authenticated',
    });

    expect(steps).toContain(
      'Outward research is blocked because the direct provider account on this host is out of quota or billing.',
    );
    expect(steps).toContain(
      'The local runtime backend is healthy, so work-cockpit flows can still run on this host.',
    );
  });

  it('adds the exact Alexa live-proof step when no signed turn is recorded', () => {
    const steps = buildVerifyNextSteps({
      missingRequirements: [],
      hasNativeOpenAiEndpointMisconfig: false,
      alexaConfigured: true,
      alexaProof: {
        lastSignedRequest: null,
        proofState: 'near_live_only',
        proofKind: 'none',
        proofFreshness: 'none',
        proofAgeMs: null,
        proofAgeMinutes: null,
        proofAgeLabel: 'none',
        blocker: 'No handled signed Alexa IntentRequest is recorded on this host yet.',
        detail: 'No signed Alexa request has been recorded on this host, so Alexa remains near-live only.',
        nextAction:
          'Use a real device or authenticated Alexa Developer Console simulator, say `Open Andrea Assistant`, then `What am I forgetting?`, and run `npm run services:status`.',
      },
    });

    expect(steps).toContain(
      'Alexa live proof still needs one fresh handled signed turn.',
    );
    expect(steps).toContain(
      'What am I forgetting?',
    );
  });

  it('separates direct-provider success from missing core-runtime configuration', () => {
    const steps = buildVerifyNextSteps({
      missingRequirements: ['credentials'],
      hasNativeOpenAiEndpointMisconfig: false,
      outwardResearchStatus: 'available',
      runtimeBackendLocalExecutionState: 'available_authenticated',
    });

    expect(steps).toContain(
      'Direct OpenAI research and image generation are live on this host',
    );
    expect(steps).toContain(
      'Anthropic-compatible core runtime lane is not configured yet',
    );
  });
});

describe('buildReportedMissingRequirements', () => {
  it('replaces generic credential blockers with the exact outward research blocker', () => {
    const requirements = buildReportedMissingRequirements({
      missingRequirements: ['credentials'],
      outwardResearchStatus: 'missing_direct_provider_credentials',
      alexaConfigured: true,
      alexaProof: {
        lastSignedRequest: null,
        proofState: 'near_live_only',
        proofKind: 'none',
        proofFreshness: 'none',
        proofAgeMs: null,
        proofAgeMinutes: null,
        proofAgeLabel: 'none',
        blocker: 'No handled signed Alexa IntentRequest is recorded on this host yet.',
        detail: 'No signed Alexa request has been recorded on this host, so Alexa remains near-live only.',
        nextAction:
          'Use a real device or authenticated Alexa Developer Console simulator, say `Open Andrea Assistant`, then `What am I forgetting?`, and run `npm run services:status`.',
      },
    });

    expect(requirements).toEqual([
      'outward_research_direct_provider_credentials_missing',
      'alexa_live_signed_turn_missing',
    ]);
  });

  it('maps runtime probe failures to specific outward research blockers', () => {
    const requirements = buildReportedMissingRequirements({
      missingRequirements: ['credential_runtime_unusable', 'service_running'],
      outwardResearchStatus: 'quota_blocked',
    });

    expect(requirements).toEqual([
      'outward_research_quota_blocked',
      'service_running',
    ]);
  });

  it('maps generic credential gaps to core-runtime blockers when direct provider proof is live', () => {
    const requirements = buildReportedMissingRequirements({
      missingRequirements: ['credentials'],
      outwardResearchStatus: 'available',
    });

    expect(requirements).toEqual(['core_runtime_credentials_missing']);
  });

  it('marks stale handled Alexa proof separately from missing proof', () => {
    const requirements = buildReportedMissingRequirements({
      missingRequirements: [],
      outwardResearchStatus: 'available',
      alexaConfigured: true,
      alexaProof: {
        lastSignedRequest: {
          updatedAt: '2026-04-05T18:00:00.000Z',
          requestId: 'req-stale',
          requestType: 'IntentRequest',
          intentName: 'WhatAmIForgettingIntent',
          applicationIdVerified: true,
          linkingResolved: true,
          groupFolder: 'main',
          responseSource: 'local_companion',
        },
        proofState: 'near_live_only',
        proofKind: 'handled_intent',
        proofFreshness: 'stale',
        proofAgeMs: 172800000,
        proofAgeMinutes: 2880,
        proofAgeLabel: '2d',
        blocker:
          'Alexa has handled signed Intent proof on this host, but it is older than 24 hours.',
        detail:
          'The latest handled signed Alexa intent was recorded at 2026-04-05T18:00:00.000Z, so the proof is now stale and Alexa remains near-live only.',
        nextAction:
          'Use a real device or authenticated Alexa Developer Console simulator, say `Open Andrea Assistant`, then `What am I forgetting?`, and run `npm run services:status`.',
      },
    });

    expect(requirements).toEqual(['alexa_live_signed_turn_stale']);
  });
});

describe('buildVerifyAlexaProofAssessment', () => {
  it('upgrades verify Alexa proof from recent field-trial truth after restart', () => {
    const effectiveProof = buildVerifyAlexaProofAssessment(
      {
        lastSignedRequest: null,
        lastHandledProofIntent: null,
        proofState: 'near_live_only',
        proofKind: 'none',
        proofFreshness: 'none',
        proofAgeMs: null,
        proofAgeMinutes: null,
        proofAgeLabel: 'none',
        blocker: 'No handled signed Alexa IntentRequest is recorded on this host yet.',
        detail:
          'No signed Alexa request has been recorded on this host, so Alexa remains near-live only.',
        nextAction:
          'Use a real device or authenticated Alexa Developer Console simulator, say `Open Andrea Assistant`, then `What am I forgetting?`, and run `npm run services:status`.',
      },
      {
        proofState: 'live_proven',
        blocker: '',
        blockerOwner: 'none',
        nextAction: '',
        detail: 'Alexa orientation was recently successful on this host.',
        lastSignedRequestAt: 'none',
        lastSignedRequestType: 'none',
        lastSignedIntent: 'none',
        lastSignedResponseSource: 'none',
        lastHandledProofAt: '2026-04-09T19:02:50.929Z',
        lastHandledProofIntent: 'alexa_orientation',
        lastHandledProofResponseSource: 'pilot_recent_success',
        proofKind: 'handled_intent',
        proofFreshness: 'fresh',
        proofAgeMinutes: 37,
        proofAgeLabel: '37m',
        recommendedUtterance: '`Open Andrea Assistant` then `What am I forgetting?`',
        confirmCommand: 'npm run services:status',
        successShape: 'Handled IntentRequest + fresh proof.',
        staleShape: 'Handled IntentRequest exists but is stale.',
        failureChecklist: 'Check the real skill path.',
      },
    );

    expect(effectiveProof.proofState).toBe('live_proven');
    expect(effectiveProof.proofKind).toBe('handled_intent');
    expect(effectiveProof.proofFreshness).toBe('fresh');
    expect(effectiveProof.lastHandledProofIntent?.intentName).toBe(
      'alexa_orientation',
    );
    expect(effectiveProof.lastHandledProofIntent?.responseSource).toBe(
      'pilot_recent_success',
    );
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

  it('classifies aborted probes as network failures', () => {
    const result = classifyCredentialProbeFailure({
      errorMessage: 'This operation was aborted',
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

describe('classifyLocalGatewayHealthPayload', () => {
  it('reports ok when the gateway has at least one healthy endpoint', () => {
    const result = classifyLocalGatewayHealthPayload({
      healthy_count: 1,
      unhealthy_count: 0,
    });

    expect(result).toEqual({
      status: 'ok',
      reason: 'ok',
    });
  });

  it('maps insufficient quota health errors to a clear failure', () => {
    const result = classifyLocalGatewayHealthPayload({
      healthy_count: 0,
      unhealthy_count: 1,
      unhealthy_endpoints: [
        {
          error:
            'RateLimitError: OpenAIException - {"error":{"code":"insufficient_quota"}}',
        },
      ],
    });

    expect(result.status).toBe('failed');
    expect(result.reason).toBe('insufficient_quota');
    expect(result.detail).toContain('out of quota');
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

describe('probeLocalGatewayHealth', () => {
  it('returns the gateway health classification for unhealthy upstreams', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          JSON.stringify({
            healthy_count: 0,
            unhealthy_count: 1,
            unhealthy_endpoints: [
              {
                error:
                  'RateLimitError: OpenAIException - {"error":{"code":"insufficient_quota"}}',
              },
            ],
          }),
          { status: 200 },
        ),
    );

    const result = await probeLocalGatewayHealth({
      hostHealthUrl: 'http://127.0.0.1:4000/health',
      requestTimeoutMs: 50,
    });

    expect(result.status).toBe('failed');
    expect(result.reason).toBe('insufficient_quota');
  });
});

describe('probeAssistantExecution', () => {
  it('blocks the assistant execution probe when credential runtime already failed', () => {
    const result = buildBlockedAssistantExecutionProbeResult({
      credentialRuntimeProbe: {
        status: 'failed',
        reason: 'insufficient_quota',
        detail: 'OpenAI key is reachable but out of quota/billing.',
      },
    });

    expect(result).toEqual({
      status: 'skipped',
      reason: 'blocked_by_credential_runtime_failure',
      detail:
        'Skipped because the credential runtime probe already failed (insufficient_quota): OpenAI key is reachable but out of quota/billing.',
    });
  });

  it('reports failure when the exact assistant probe times out before first output', async () => {
    const result = await probeAssistantExecution({
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

    expect(result.status).toBe('failed');
    expect(result.reason).toBe('initial_output_timeout');
    expect(result.detail).toContain('exact probe failed');
    expect(result.detail).toContain(
      'container did not emit first structured result before timeout',
    );
    expect(result.detail).toContain(
      'verify retried the subprobe once in a fresh container',
    );
  });

  it('reports success when exact, summary, and refinement probes all return assistant text', async () => {
    const prompts: string[] = [];
    const freshSessionHomeFlags: boolean[] = [];
    const result = await probeAssistantExecution({
      runProbe: async (_group, input, _onProcess, onOutput) => {
        prompts.push(input.prompt);
        freshSessionHomeFlags.push(input.freshSessionHome === true);
        await onOutput?.({
          status: 'success',
          result:
            prompts.length === 1
              ? 'assistant execution probe ok.'
              : prompts.length === 2
                ? 'Andrea_NanoBot is Andrea’s Telegram-first orchestration shell for practical automation across multiple backend lanes.'
                : 'Andrea_NanoBot is Andrea’s Telegram-first automation shell.',
          newSessionId: `probe-session-${prompts.length}`,
        });
        return {
          status: 'success',
          result: null,
          newSessionId: `probe-session-${prompts.length}`,
        };
      },
    });

    expect(result.status).toBe('ok');
    expect(result.reason).toBe('ok');
    expect(result.detail).toContain('exact session=probe-session-1');
    expect(result.detail).toContain('summary session=probe-session-2');
    expect(result.detail).toContain('refinement session=probe-session-3');
    expect(prompts[0]).toContain('<context timezone="America/Chicago" />');
    expect(prompts[0]).toContain(
      'Reply with exactly: assistant execution probe ok.',
    );
    expect(prompts[1]).toContain('<context timezone="America/Chicago" />');
    expect(prompts[1]).toContain(
      "Summarize Andrea_NanoBot's role in one sentence. Do not modify files, branches, or PRs.",
    );
    expect(prompts[2]).toContain(
      'Rewrite this sentence in a shorter way while preserving the meaning.',
    );
    expect(prompts[2]).toContain('<context timezone="America/Chicago" />');
    expect(freshSessionHomeFlags).toEqual([true, true, true]);
  });

  it('retries the refinement probe with the alternate rewrite prompt when the first attempt fails', async () => {
    const prompts: string[] = [];
    const result = await probeAssistantExecution({
      runProbe: async (_group, input, _onProcess, onOutput) => {
        prompts.push(input.prompt);
        if (prompts.length === 1) {
          await onOutput?.({
            status: 'success',
            result: 'assistant execution probe ok.',
            newSessionId: 'probe-session-1',
          });
          return {
            status: 'success',
            result: null,
            newSessionId: 'probe-session-1',
          };
        }
        if (prompts.length === 2) {
          await onOutput?.({
            status: 'success',
            result:
              'Andrea_NanoBot is Andrea’s Telegram-first orchestration shell for practical automation across multiple backend lanes.',
            newSessionId: 'probe-session-2',
          });
          return {
            status: 'success',
            result: null,
            newSessionId: 'probe-session-2',
          };
        }
        if (prompts.length === 3 || prompts.length === 4) {
          return {
            status: 'error',
            result: null,
            error: 'Container exited with code 1.',
            failureKind: 'runtime_bootstrap_failed',
            failureStage: 'runtime',
            diagnosticHint:
              'assistant runtime hit a transient execution failure before producing a stable answer',
            recoveryAttempted: true,
          };
        }
        await onOutput?.({
          status: 'success',
          result: 'Andrea_NanoBot is Andrea’s Telegram-first automation shell.',
          newSessionId: 'probe-session-4',
        });
        return {
          status: 'success',
          result: null,
          newSessionId: 'probe-session-4',
        };
      },
    });

    expect(result.status).toBe('ok');
    expect(prompts).toHaveLength(5);
    expect(prompts[2]).toContain(
      'Rewrite this sentence in a shorter way while preserving the meaning.',
    );
    expect(prompts[3]).toContain(
      'Rewrite this sentence in a shorter way while preserving the meaning.',
    );
    expect(prompts[4]).toContain('Return a shorter version of this sentence:');
  });

  it('retries the summary probe once in a fresh container when the first attempt fails', async () => {
    const prompts: string[] = [];
    const result = await probeAssistantExecution({
      runProbe: async (_group, input, _onProcess, onOutput) => {
        prompts.push(input.prompt);
        if (prompts.length === 1) {
          await onOutput?.({
            status: 'success',
            result: 'assistant execution probe ok.',
            newSessionId: 'probe-session-1',
          });
          return {
            status: 'success',
            result: null,
            newSessionId: 'probe-session-1',
          };
        }
        if (prompts.length === 2) {
          return {
            status: 'error',
            result: null,
            error: 'Container exited with code 1.',
            failureKind: 'runtime_bootstrap_failed',
            failureStage: 'runtime',
            diagnosticHint:
              'assistant runtime hit a transient execution failure before producing a stable answer',
            recoveryAttempted: true,
          };
        }
        if (prompts.length === 3) {
          await onOutput?.({
            status: 'success',
            result:
              'Andrea_NanoBot is Andrea’s Telegram-first orchestration shell for practical automation across multiple backend lanes.',
            newSessionId: 'probe-session-3',
          });
          return {
            status: 'success',
            result: null,
            newSessionId: 'probe-session-3',
          };
        }
        await onOutput?.({
          status: 'success',
          result: 'Andrea_NanoBot is Andrea’s Telegram-first automation shell.',
          newSessionId: 'probe-session-4',
        });
        return {
          status: 'success',
          result: null,
          newSessionId: 'probe-session-4',
        };
      },
    });

    expect(result.status).toBe('ok');
    expect(result.detail).toContain('summary session=probe-session-3');
    expect(result.detail).toContain(
      'verify retried the subprobe once in a fresh container',
    );
    expect(prompts).toHaveLength(4);
    expect(prompts[1]).toContain(
      "Summarize Andrea_NanoBot's role in one sentence. Do not modify files, branches, or PRs.",
    );
    expect(prompts[2]).toContain(
      "Summarize Andrea_NanoBot's role in one sentence. Do not modify files, branches, or PRs.",
    );
  });

  it('fails when the summary probe only sees lifecycle output', async () => {
    let callCount = 0;
    const result = await probeAssistantExecution({
      runProbe: async (_group, _input, _onProcess, onOutput) => {
        callCount += 1;
        if (callCount === 1) {
          await onOutput?.({
            status: 'success',
            result: 'assistant execution probe ok.',
            newSessionId: 'probe-session-1',
          });
          return {
            status: 'success',
            result: null,
            newSessionId: 'probe-session-1',
          };
        }
        await onOutput?.({
          status: 'success',
          result: null,
          newSessionId: 'probe-session-2',
          sawLifecycleOnlyOutput: true,
        });
        return {
          status: 'success',
          result: null,
          newSessionId: 'probe-session-2',
          sawLifecycleOnlyOutput: true,
        };
      },
    });

    expect(result.status).toBe('failed');
    expect(result.reason).toBe('runtime_bootstrap_failed');
    expect(result.detail).toContain('summary probe failed');
    expect(result.detail).toContain('lifecycle output');
  });

  it('includes retry detail when the refinement probe exhausted one recovery retry', async () => {
    let callCount = 0;
    const result = await probeAssistantExecution({
      runProbe: async (_group, _input, _onProcess, onOutput) => {
        callCount += 1;
        if (callCount < 3) {
          await onOutput?.({
            status: 'success',
            result:
              callCount === 1
                ? 'assistant execution probe ok.'
                : 'Andrea_NanoBot is Andrea’s Telegram-first orchestration shell.',
            newSessionId: `probe-session-${callCount}`,
          });
          return {
            status: 'success',
            result: null,
            newSessionId: `probe-session-${callCount}`,
          };
        }
        return {
          status: 'error',
          result: null,
          error: 'Container exited with code 1.',
          failureKind: 'runtime_bootstrap_failed',
          failureStage: 'runtime',
          diagnosticHint:
            'assistant runtime hit a transient execution failure before producing a stable answer',
          recoveryAttempted: true,
        };
      },
    });

    expect(result.status).toBe('failed');
    expect(result.detail).toContain('refinement probe failed');
    expect(result.detail).toContain('recovery retry');
  });
});
