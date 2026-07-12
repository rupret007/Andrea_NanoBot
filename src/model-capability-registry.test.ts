import { beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  listAssistantMetricEvents,
  updateAssistantMetricEventMetadata,
} from './db.js';

import {
  buildConfiguredModelCatalog,
  buildModelCapabilityRegistry,
  buildModelHealthFromProviderSnapshots,
  GROUNDED_AGENCY_EVALUATION_CASES,
  LiveRoutingEvaluationBudget,
  recordLiveRoutingEvaluation,
  repairGroundedAgencyOutcomeLabels,
  rankModelsForTask,
} from './model-capability-registry.js';
import { DEFAULT_CATALOG } from './models/router.js';
import type { ProviderHealthSnapshot } from './provider-health.js';

function providerHealth(
  providerId: string,
  state: ProviderHealthSnapshot['state'],
  healthEvidence: 'configuration_only' | 'live_probe',
): ProviderHealthSnapshot {
  return {
    providerId,
    kind: 'llm',
    state,
    lastHealthyAt: state === 'healthy' ? '2026-07-12T12:00:00.000Z' : null,
    lastCheckedAt: '2026-07-12T12:00:00.000Z',
    failureClass: state === 'healthy' ? 'none' : 'unknown',
    quotaState: 'unknown',
    credentialState: state === 'not_configured' ? 'missing' : 'configured',
    knownExpiresAt: null,
    rotationDueAt: null,
    blocker: '',
    nextAction: '',
    metadata: {
      healthEvidence,
      liveProbe: healthEvidence === 'live_probe' ? 'ok' : 'not_run',
    },
  };
}

describe('model capability registry', () => {
  beforeEach(() => _initTestDatabase());
  it('adds configured model identifiers without removing pinned defaults', () => {
    const catalog = buildConfiguredModelCatalog(DEFAULT_CATALOG, {
      OPENAI_MODEL_COMPLEX: 'gpt-current-complex',
      GEMINI_MODEL_FAST: 'gemini-current-fast',
    });
    expect(catalog.some((model) => model.id === 'gpt-current-complex')).toBe(
      true,
    );
    expect(catalog.some((model) => model.id === 'gemini-current-fast')).toBe(
      true,
    );
    expect(catalog.some((model) => model.id === 'gpt-5')).toBe(true);
  });

  it('routes ordinary work for speed and deep work for coding capability', () => {
    const registry = buildModelCapabilityRegistry({
      catalog: DEFAULT_CATALOG,
      health: {
        'claude-sonnet-4-6': 'healthy',
        'claude-haiku-4-5-20251001': 'healthy',
      },
    });
    expect(rankModelsForTask(registry, 'ordinary_assistance')[0]?.id).toBe(
      'claude-haiku-4-5-20251001',
    );
    expect(rankModelsForTask(registry, 'deep_work')[0]?.capabilities).toContain(
      'code',
    );
  });

  it('maps configuration and live-probe evidence to model health without inflating readiness', () => {
    const catalog = buildConfiguredModelCatalog(DEFAULT_CATALOG, {
      OPENAI_MODEL_COMPLEX: 'gpt-configured-current',
      GEMINI_MODEL_CRITIC: 'gemini-configured-current',
    });
    const health = buildModelHealthFromProviderSnapshots(catalog, [
      providerHealth('openai_cloud', 'healthy', 'configuration_only'),
      providerHealth('anthropic_cloud', 'healthy', 'live_probe'),
      providerHealth('gemini_cloud', 'degraded', 'live_probe'),
    ]);

    expect(health['gpt-5']).toBe('unknown');
    expect(health['gpt-configured-current']).toBe('unknown');
    expect(health['claude-sonnet-4-6']).toBe('healthy');
    expect(health['gemini-configured-current']).toBe('degraded');
    expect(health['llama3.3:70b']).toBe('blocked');
  });

  it('defines twelve redacted cases and fails closed at the live cost cap', () => {
    expect(GROUNDED_AGENCY_EVALUATION_CASES).toHaveLength(12);
    expect(
      GROUNDED_AGENCY_EVALUATION_CASES.every(
        (item) => item.containsRawUserText === false,
      ),
    ).toBe(true);
    const budget = new LiveRoutingEvaluationBudget(25);
    budget.reserve(24.5);
    expect(() => budget.reserve(0.51)).toThrow('cost cap would be exceeded');
  });

  it('records metadata-only live routing outcomes and cost', () => {
    const budget = new LiveRoutingEvaluationBudget(25);
    recordLiveRoutingEvaluation({
      groupFolder: 'main',
      budget,
      caseId: 'coding-1',
      provider: 'openai',
      model: 'gpt-test',
      latencyMs: 900,
      costUsd: 0.03,
      outcome: 'structural_pass',
      evidenceCoverage: 1,
      toolCorrect: true,
    });
    expect(budget.spent).toBe(0.03);
    const events = listAssistantMetricEvents({ groupFolder: 'main' });
    expect(events.map((event) => event.kind)).toEqual(
      expect.arrayContaining([
        'latency_sample',
        'live_eval_cost',
        'tool_attempt',
        'tool_success',
      ]),
    );
    expect(
      events.every((event) => !event.metadataJson.includes('prompt')),
    ).toBe(true);
    expect(
      events.find((event) => event.kind === 'latency_sample')?.metadataJson,
    ).toContain('"latencyClass":"live_evaluation"');
    expect(
      events.every((event) =>
        event.metadataJson.includes('"metricClass":"live_evaluation"'),
      ),
    ).toBe(true);
  });

  it('repairs the initial structural-pass label without changing metric values', () => {
    const budget = new LiveRoutingEvaluationBudget(25);
    recordLiveRoutingEvaluation({
      groupFolder: 'main',
      budget,
      caseId: 'daily-1',
      provider: 'openai',
      model: 'gpt-test',
      latencyMs: 100,
      costUsd: 0.01,
      outcome: 'structural_pass',
      evidenceCoverage: 1,
      toolCorrect: true,
    });
    const events = listAssistantMetricEvents({ groupFolder: 'main' });
    const first = events[0]!;
    const metadata = JSON.parse(first.metadataJson) as Record<string, unknown>;
    metadata.outcome = 'verified';
    updateAssistantMetricEventMetadata(first.eventId, JSON.stringify(metadata));
    expect(repairGroundedAgencyOutcomeLabels('main')).toBeGreaterThan(0);
    expect(
      listAssistantMetricEvents({ groupFolder: 'main' }).every(
        (event) => !event.metadataJson.includes('"outcome":"verified"'),
      ),
    ).toBe(true);
  });
});
