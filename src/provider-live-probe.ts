import { runAnthropicText } from './anthropic-provider.js';
import { searchBraveWeb } from './brave-search.js';
import { runGeminiOpenAiText } from './gemini-provider.js';
import { runMiniMaxAnthropicText } from './minimax-provider.js';
import { runOpenAiChatText } from './openai-provider.js';
import {
  collectProviderHealthSnapshots,
  type ProviderFailureClass,
  type ProviderHealthSnapshot,
} from './provider-health.js';

export interface ProviderLiveProbeStatus {
  liveOk: boolean;
  liveFailure: string;
  liveModel?: string;
  liveRequestId?: string;
}

export function providerFailureClassFromMessage(
  message: string,
): ProviderFailureClass {
  const normalized = message.toLowerCase();
  if (!message) return 'none';
  if (
    normalized.includes('quota') ||
    normalized.includes('rate limit') ||
    normalized.includes('rate-limit') ||
    normalized.includes('billing') ||
    normalized.includes('balance')
  ) {
    return 'quota_or_rate_limit';
  }
  if (
    normalized.includes('api key') ||
    normalized.includes('unauthorized') ||
    normalized.includes('auth token') ||
    normalized.includes('subscription token')
  ) {
    return 'auth_failure';
  }
  if (
    normalized.includes('transport') ||
    normalized.includes('network') ||
    normalized.includes('fetch') ||
    normalized.includes('timeout')
  ) {
    return 'transport_error';
  }
  return 'unknown';
}

export function nextActionForProviderLiveFailure(
  providerId: string,
  message: string,
): string {
  const failureClass = providerFailureClassFromMessage(message);
  if (failureClass === 'quota_or_rate_limit') {
    return `Wait for ${providerId} quota/rate-limit recovery or adjust that provider plan, then rerun npm run debug:providers.`;
  }
  if (failureClass === 'auth_failure') {
    return `Regenerate or replace the ${providerId} credential, then rerun npm run debug:providers.`;
  }
  if (failureClass === 'transport_error') {
    return `Check network/DNS access for ${providerId}, then rerun npm run debug:providers.`;
  }
  return `Inspect the ${providerId} live probe failure and rerun npm run debug:providers after the provider-side issue is resolved.`;
}

export function applyProviderLiveProbe(
  provider: ProviderHealthSnapshot,
  probe: ProviderLiveProbeStatus,
  checkedAt: string,
): ProviderHealthSnapshot {
  if (probe.liveOk) {
    return {
      ...provider,
      state:
        provider.credentialState === 'configured' ? 'healthy' : provider.state,
      failureClass:
        provider.credentialState === 'configured'
          ? 'none'
          : provider.failureClass,
      lastHealthyAt: checkedAt,
      blocker: '',
      nextAction: '',
      metadata: {
        ...provider.metadata,
        liveProbe: 'ok',
        liveModel: probe.liveModel || '',
        liveRequestId: probe.liveRequestId || '',
      },
    };
  }
  if (!probe.liveFailure) {
    return {
      ...provider,
      metadata: {
        ...provider.metadata,
        liveProbe: 'not_run',
      },
    };
  }
  const failureClass = providerFailureClassFromMessage(probe.liveFailure);
  return {
    ...provider,
    state:
      failureClass === 'quota_or_rate_limit'
        ? 'externally_blocked'
        : provider.state === 'not_configured'
          ? 'not_configured'
          : 'degraded',
    lastHealthyAt: null,
    failureClass,
    quotaState:
      failureClass === 'quota_or_rate_limit' ? 'blocked' : provider.quotaState,
    blocker: probe.liveFailure,
    nextAction: nextActionForProviderLiveFailure(
      provider.providerId,
      probe.liveFailure,
    ),
    metadata: {
      ...provider.metadata,
      liveProbe: 'failed',
      liveFailureClass: failureClass,
    },
  };
}

export async function probeProviderLive(
  providerId: string,
): Promise<ProviderLiveProbeStatus> {
  if (providerId === 'openai_cloud') {
    const result = await runOpenAiChatText({
      prompt: 'Reply with exactly: ok',
      modelTier: 'simple',
      maxTokens: 20,
      temperature: 0.1,
    });
    if (result && 'text' in result) {
      return {
        liveOk: true,
        liveFailure: '',
        liveModel: result.model,
        liveRequestId: result.requestId,
      };
    }
    return {
      liveOk: false,
      liveFailure:
        result && 'providerFailure' in result
          ? result.providerFailure
          : 'OpenAI live probe was not configured.',
    };
  }
  if (providerId === 'minimax_cloud') {
    const result = await runMiniMaxAnthropicText({
      prompt: 'Reply with exactly: ok',
      modelTier: 'fast',
      maxTokens: 20,
      temperature: 0.1,
    });
    if (result && 'text' in result) {
      return {
        liveOk: true,
        liveFailure: '',
        liveModel: result.model,
        liveRequestId: result.requestId,
      };
    }
    return {
      liveOk: false,
      liveFailure:
        result && 'providerFailure' in result
          ? result.providerFailure
          : 'MiniMax live probe was not configured.',
    };
  }
  if (providerId === 'gemini_cloud') {
    const result = await runGeminiOpenAiText({
      prompt: 'Reply with exactly: ok',
      modelTier: 'fast',
      maxTokens: 20,
      temperature: 0.1,
    });
    if (result && 'text' in result) {
      return {
        liveOk: true,
        liveFailure: '',
        liveModel: result.model,
        liveRequestId: result.requestId,
      };
    }
    return {
      liveOk: false,
      liveFailure:
        result && 'providerFailure' in result
          ? result.providerFailure
          : 'Gemini live probe was not configured.',
    };
  }
  if (providerId === 'anthropic_cloud') {
    const result = await runAnthropicText({
      prompt: 'Reply with exactly: ok',
      modelTier: 'fast',
      maxTokens: 20,
      temperature: 0.1,
    });
    if (result && 'text' in result) {
      return {
        liveOk: true,
        liveFailure: '',
        liveModel: result.model,
        liveRequestId: result.requestId,
      };
    }
    return {
      liveOk: false,
      liveFailure:
        result && 'providerFailure' in result
          ? result.providerFailure
          : 'Anthropic live probe was not configured.',
    };
  }
  if (providerId === 'brave_search') {
    const result = await searchBraveWeb('Andrea NanoBot provider health probe');
    if (result && 'results' in result) {
      return {
        liveOk: result.results.length > 0,
        liveFailure:
          result.results.length > 0
            ? ''
            : 'Brave Search returned no live results for the health probe.',
        liveRequestId: result.requestId,
      };
    }
    return {
      liveOk: false,
      liveFailure:
        result && 'providerFailure' in result
          ? result.providerFailure
          : 'Brave Search live probe was not configured.',
    };
  }
  return { liveOk: false, liveFailure: 'No live probe is implemented.' };
}

export async function collectProviderHealthSnapshotsWithLiveProbe(
  checkedAt: string,
): Promise<ProviderHealthSnapshot[]> {
  const providers = collectProviderHealthSnapshots(checkedAt);
  const probes = await Promise.all(
    providers.map(async (provider) => ({
      provider,
      probe:
        provider.credentialState === 'configured'
          ? await probeProviderLive(provider.providerId)
          : { liveOk: false, liveFailure: '' },
    })),
  );
  return probes.map(({ provider, probe }) =>
    applyProviderLiveProbe(provider, probe, checkedAt),
  );
}
