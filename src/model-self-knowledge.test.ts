import { describe, expect, it } from 'vitest';

import { getAnthropicProviderStatus } from './anthropic-provider.js';
import { getGeminiProviderStatus } from './gemini-provider.js';
import { getMiniMaxProviderStatus } from './minimax-provider.js';
import {
  buildRuntimeModelInventory,
  formatChineseModelInventoryReply,
  formatRuntimeModelInventoryReply,
} from './model-self-knowledge.js';
import { getOpenAiProviderStatus } from './openai-provider.js';
import type { ProviderHealthSnapshot } from './provider-health.js';

function health(
  providerId: string,
  state: ProviderHealthSnapshot['state'] = 'healthy',
  evidence: 'injected' | 'configuration_only' = 'injected',
): ProviderHealthSnapshot {
  return {
    providerId,
    kind: 'llm',
    state,
    lastHealthyAt: state === 'healthy' ? '2026-07-11T12:00:00.000Z' : null,
    lastCheckedAt: '2026-07-11T12:00:00.000Z',
    failureClass: state === 'healthy' ? 'none' : 'unknown',
    quotaState: 'unknown',
    credentialState: state === 'not_configured' ? 'missing' : 'configured',
    knownExpiresAt: null,
    rotationDueAt: null,
    blocker: '',
    nextAction: '',
    metadata:
      evidence === 'configuration_only'
        ? { healthEvidence: 'configuration_only', liveProbe: 'not_run' }
        : {},
  };
}

function configuredStatuses() {
  return {
    openai: {
      ...getOpenAiProviderStatus(),
      configured: true,
      missing: [],
      simpleModel: 'gpt-test-fast',
      standardModel: 'gpt-test',
      complexModel: 'gpt-test',
      researchModel: 'gpt-test-research',
    },
    anthropic: {
      ...getAnthropicProviderStatus(),
      configured: true,
      missing: [],
      complexModel: 'claude-test-deep',
      fastModel: 'claude-test-fast',
    },
    gemini: {
      ...getGeminiProviderStatus(),
      configured: true,
      missing: [],
      criticModel: 'gemini-test-pro',
      fastModel: 'gemini-test-fast',
    },
    minimax: {
      ...getMiniMaxProviderStatus(),
      configured: true,
      missing: [],
      complexModel: 'minimax-test-deep',
      fastModel: 'minimax-test-fast',
    },
  };
}

describe('runtime model self-knowledge', () => {
  it('compiles configured models and current health without duplicating tiers', () => {
    const inventory = buildRuntimeModelInventory({
      statuses: configuredStatuses(),
      health: [
        health('openai_cloud'),
        health('anthropic_cloud'),
        health('gemini_cloud', 'degraded'),
        health('minimax_cloud'),
      ],
      defaultModel: 'minimax-test-deep',
    });

    expect(inventory.defaultModel).toBe('minimax-test-deep');
    expect(inventory.providers).toHaveLength(4);
    expect(
      inventory.providers.find((item) => item.providerId === 'openai_cloud')
        ?.models,
    ).toEqual(['gpt-test-fast', 'gpt-test', 'gpt-test-research']);
    expect(
      inventory.providers.find((item) => item.providerId === 'gemini_cloud')
        ?.state,
    ).toBe('degraded');
    expect(inventory.privacy).toEqual({
      credentialsIncluded: false,
      endpointsIncluded: false,
    });
  });

  it('explains default versus council use instead of claiming one model powers everything', () => {
    const inventory = buildRuntimeModelInventory({
      statuses: configuredStatuses(),
      health: [
        health('openai_cloud'),
        health('anthropic_cloud'),
        health('gemini_cloud'),
        health('minimax_cloud'),
      ],
      defaultModel: 'minimax-test-deep',
    });
    const reply = formatRuntimeModelInventoryReply(inventory);

    expect(reply).toContain("I don't run on only one LLM");
    expect(reply).toContain('defaults to minimax-test-deep');
    expect(reply).toContain('OpenAI');
    expect(reply).toContain('Anthropic');
    expect(reply).toContain('Google Gemini');
    expect(reply).toContain('MiniMax');
    expect(reply).toContain('ordinary reply');
    expect(reply).toContain('council work');
    expect(reply).not.toMatch(/api[-_ ]?key|https?:\/\//i);
  });

  it('does not resurrect an unconfigured provider from stale health', () => {
    const statuses = configuredStatuses();

    const inventory = buildRuntimeModelInventory({
      statuses: {
        ...statuses,
        gemini: {
          ...statuses.gemini,
          configured: false,
          missing: ['GEMINI_API_KEY'],
        },
      },
      health: [health('gemini_cloud')],
      defaultModel: 'minimax-test-deep',
    });

    expect(
      inventory.providers.some(
        (provider) => provider.providerId === 'gemini_cloud',
      ),
    ).toBe(false);
  });

  it('labels configured-only health as unverified instead of claiming a live provider', () => {
    const inventory = buildRuntimeModelInventory({
      statuses: configuredStatuses(),
      health: [
        health('openai_cloud', 'healthy', 'configuration_only'),
        health('anthropic_cloud', 'healthy', 'configuration_only'),
        health('gemini_cloud', 'healthy', 'configuration_only'),
        health('minimax_cloud', 'healthy', 'configuration_only'),
      ],
      defaultModel: 'minimax-test-deep',
    });

    expect(
      inventory.providers.every((provider) => provider.state === 'unknown'),
    ).toBe(true);
    expect(formatRuntimeModelInventoryReply(inventory)).toContain(
      'configured; live health not recently checked',
    );
  });

  it('answers the Chinese-provider question directly', () => {
    const inventory = buildRuntimeModelInventory({
      statuses: configuredStatuses(),
      health: [health('minimax_cloud')],
      defaultModel: 'minimax-test-deep',
    });

    expect(formatChineseModelInventoryReply(inventory)).toBe(
      'The Chinese-model integration is MiniMax. The configured MiniMax models are minimax-test-deep and minimax-test-fast. minimax-test-deep is also my current default conversational worker.',
    );
  });
});
